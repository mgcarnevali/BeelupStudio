/*
 * Beelup Studio — remuxer MPEG-TS (H.264 + AAC) → MP4 progresivo.
 *
 * JavaScript puro: no usa WebAssembly, SharedArrayBuffer, Workers ni
 * encabezados COOP/COEP, por lo que funciona en GitHub Pages y en cualquier
 * navegador moderno. No recodifica: copia los paquetes H.264/AAC originales y
 * genera un MP4 "faststart" (moov antes de mdat) con tablas de muestras
 * completas (stts/ctts/stss/stsc/stsz/stco), es decir, con navegación precisa.
 *
 * Particularidades de Beelup que maneja:
 *  - La playlist une varios archivos de 5 min; los timestamps se reinician en
 *    cada uno (#EXT-X-DISCONTINUITY). Se reconstruye una línea de tiempo
 *    continua y se mantiene la sincronía audio/video.
 *  - Segmentos vacíos (sólo PAT/PMT) y pistas ID3 se ignoran.
 *  - Frecuencia de cuadro variable: se usan las duraciones reales.
 *
 * Los datos de las muestras se guardan en Blobs por segmento, de modo que
 * la memoria de JavaScript sólo contiene el segmento en proceso.
 */
(function (root) {
  'use strict';

  const TS = 90000;               // reloj MPEG (90 kHz), también timescale del video
  const WRAP = 2 ** 33;
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  // Tramas AAC-LC silenciosas (mismas que usa hls.js) para cubrir huecos de audio.
  const SILENT_AAC = {
    1: [0x00, 0xc8, 0x00, 0x80, 0x23, 0x80],
    2: [0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80],
    3: [0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x8e],
    4: [0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x80, 0x2c, 0x80, 0x08, 0x02, 0x38],
    5: [0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99, 0x00, 0x21, 0x90, 0x02, 0x38],
    6: [0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99, 0x00, 0x21, 0x90, 0x02, 0x00, 0xb2, 0x00, 0x20, 0x08, 0xe0]
  };

  class RemuxError extends Error {}

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function concatBytes(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    if (total === undefined) total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // Lleva un timestamp de 33 bits a la vuelta más cercana a `ref`.
  function unwrap(value, ref) {
    if (ref === null || ref === undefined) return value;
    while (value - ref > WRAP / 2) value -= WRAP;
    while (ref - value > WRAP / 2) value += WRAP;
    return value;
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Demultiplexor MPEG-TS                                               */
  /* ------------------------------------------------------------------ */

  function readPts(d, o) {
    return (d[o] & 0x0e) * 536870912 + // << 29
      d[o + 1] * 4194304 +             // << 22
      (d[o + 2] & 0xfe) * 16384 +      // << 14
      d[o + 3] * 128 +                 // << 7
      (d[o + 4] >>> 1);
  }

  function parsePes(data) {
    if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return null;
    const flags = data[7];
    const headerLen = data[8];
    let pts = null, dts = null;
    if (flags & 0x80) {
      pts = readPts(data, 9);
      dts = (flags & 0x40) ? readPts(data, 14) : pts;
    }
    const start = 9 + headerLen;
    if (start > data.length) return null;
    return { pts, dts, payload: data.subarray(start) };
  }

  /** Devuelve los PES de video (H.264) y audio (AAC ADTS) de un segmento TS. */
  function demuxTs(bytes, state) {
    const out = { video: [], audio: [] };
    const pending = new Map(); // pid → {chunks, size}
    let pos = 0;
    // Sincronizar con el primer paquete válido.
    while (pos + 188 <= bytes.length && !(bytes[pos] === 0x47 && (pos + 188 >= bytes.length || bytes[pos + 188] === 0x47))) pos++;

    const flush = pid => {
      const p = pending.get(pid);
      if (!p || !p.size) return;
      pending.delete(pid);
      const pes = parsePes(concatBytes(p.chunks, p.size));
      if (!pes) return;
      if (pid === state.videoPid) out.video.push(pes);
      else if (pid === state.audioPid) out.audio.push(pes);
    };

    for (; pos + 188 <= bytes.length; pos += 188) {
      if (bytes[pos] !== 0x47) {
        // Pérdida de sincronía: buscar el siguiente byte 0x47.
        let next = pos + 1;
        while (next + 188 <= bytes.length && bytes[next] !== 0x47) next++;
        pos = next - 188;
        continue;
      }
      const pusi = (bytes[pos + 1] & 0x40) !== 0;
      const pid = ((bytes[pos + 1] & 0x1f) << 8) | bytes[pos + 2];
      const afc = (bytes[pos + 3] >> 4) & 3;
      let off = pos + 4;
      if (afc === 2 || afc === 0) continue; // sin carga útil
      if (afc === 3) off += 1 + bytes[pos + 4];
      if (off >= pos + 188) continue;
      const payload = bytes.subarray(off, pos + 188);

      if (pid === 0) {
        const p = pusi ? payload.subarray(1 + payload[0]) : payload;
        // PAT: primer programa
        const secLen = ((p[1] & 0x0f) << 8) | p[2];
        for (let i = 8; i + 4 <= 3 + secLen - 4; i += 4) {
          const prog = (p[i] << 8) | p[i + 1];
          if (prog !== 0) { state.pmtPid = ((p[i + 2] & 0x1f) << 8) | p[i + 3]; break; }
        }
        continue;
      }
      if (pid === state.pmtPid) {
        const p = pusi ? payload.subarray(1 + payload[0]) : payload;
        const secLen = ((p[1] & 0x0f) << 8) | p[2];
        const progInfoLen = ((p[10] & 0x0f) << 8) | p[11];
        const end = Math.min(p.length, 3 + secLen - 4);
        for (let i = 12 + progInfoLen; i + 5 <= end;) {
          const type = p[i];
          const epid = ((p[i + 1] & 0x1f) << 8) | p[i + 2];
          const esLen = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
          if (type === 0x1b && state.videoPid === null) state.videoPid = epid;
          else if (type === 0x0f && state.audioPid === null) state.audioPid = epid;
          else if (type === 0x24 || type === 0x27) state.unsupported = 'H.265/HEVC';
          else if (type === 0x03 || type === 0x04) state.unsupported = state.unsupported || 'audio MPEG';
          i += 5 + esLen;
        }
        continue;
      }
      if (pid !== state.videoPid && pid !== state.audioPid) continue;
      if (pusi) {
        flush(pid);
        pending.set(pid, { chunks: [payload], size: payload.length });
      } else {
        const p = pending.get(pid);
        if (p) { p.chunks.push(payload); p.size += payload.length; }
      }
    }
    flush(state.videoPid);
    flush(state.audioPid);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* H.264                                                               */
  /* ------------------------------------------------------------------ */

  // Divide un flujo Annex B en NAL units (sin códigos de inicio).
  function splitNals(d) {
    const nals = [];
    let i = 0, start = -1;
    const n = d.length;
    while (i + 2 < n) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
        if (start >= 0) {
          let end = i;
          while (end > start && d[end - 1] === 0) end--; // ceros finales / código de 4 bytes
          if (end > start) nals.push(d.subarray(start, end));
        }
        i += 3;
        start = i;
      } else i++;
    }
    if (start >= 0 && start < n) {
      let end = n;
      while (end > start && d[end - 1] === 0) end--;
      if (end > start) nals.push(d.subarray(start, end));
    }
    return nals;
  }

  // Quita los bytes de prevención de emulación (00 00 03).
  function unescapeRbsp(nal) {
    const out = new Uint8Array(nal.length);
    let o = 0, zeros = 0;
    for (let i = 0; i < nal.length; i++) {
      const b = nal[i];
      if (zeros >= 2 && b === 3) { zeros = 0; continue; }
      out[o++] = b;
      zeros = b === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, o);
  }

  class BitReader {
    constructor(bytes) { this.b = bytes; this.p = 0; }
    bit() { const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; }
    bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
    ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1) + this.bits(z) : 0; }
    se() { const v = this.ue(); return v & 1 ? (v + 1) / 2 : -v / 2; }
  }

  function parseSps(nal) {
    const r = new BitReader(unescapeRbsp(nal));
    r.bits(8);
    const profile = r.bits(8);
    r.bits(8); // constraint flags
    r.bits(8); // level
    r.ue();
    let chromaFormat = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chromaFormat = r.ue();
      if (chromaFormat === 3) r.bit();
      r.ue(); r.ue(); r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
          if (r.bit()) {
            const size = i < 6 ? 16 : 64;
            let last = 8, next = 8;
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + r.se() + 256) % 256;
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); r.bit();
    const wMbs = r.ue() + 1;
    const hMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    let sarW = 1, sarH = 1;
    if (r.bit()) { // VUI
      if (r.bit()) {
        const idc = r.bits(8);
        const table = [[1, 1], [1, 1], [12, 11], [10, 11], [16, 11], [40, 33], [24, 11], [20, 11], [32, 11], [80, 33], [18, 11], [15, 11], [64, 33], [160, 99], [4, 3], [3, 2], [2, 1]];
        if (idc === 255) { sarW = r.bits(16); sarH = r.bits(16); } else if (table[idc]) [sarW, sarH] = table[idc];
      }
    }
    const subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subH = (chromaFormat === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = wMbs * 16 - (cl + cr) * (chromaFormat ? subW : 1);
    const height = (2 - frameMbsOnly) * hMapUnits * 16 - (ct + cb) * (chromaFormat ? subH : 2 - frameMbsOnly);
    return { width, height, sarW: sarW || 1, sarH: sarH || 1, profile };
  }

  /* ------------------------------------------------------------------ */
  /* Escritura de cajas MP4                                              */
  /* ------------------------------------------------------------------ */

  class Writer {
    constructor(size = 1024) { this.buf = new Uint8Array(size); this.view = new DataView(this.buf.buffer); this.pos = 0; }
    ensure(n) {
      if (this.pos + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.pos + n) size *= 2;
      const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.pos));
      this.buf = b; this.view = new DataView(b.buffer);
    }
    u8(v) { this.ensure(1); this.buf[this.pos++] = v; }
    u16(v) { this.ensure(2); this.view.setUint16(this.pos, v); this.pos += 2; }
    u24(v) { this.u8((v >>> 16) & 255); this.u16(v & 0xffff); }
    u32(v) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0); this.pos += 4; }
    i32(v) { this.ensure(4); this.view.setInt32(this.pos, v); this.pos += 4; }
    u64(v) { this.u32(Math.floor(v / 4294967296)); this.u32(v % 4294967296); }
    bytes(a) { this.ensure(a.length); this.buf.set(a, this.pos); this.pos += a.length; }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
    zeros(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; }
    box(type, fn) { const start = this.pos; this.u32(0); this.str(type); fn(); this.view.setUint32(start, this.pos - start); }
    full(type, version, flags, fn) { this.box(type, () => { this.u8(version); this.u24(flags); fn(); }); }
    result() { return this.buf.slice(0, this.pos); }
  }

  const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

  /* ------------------------------------------------------------------ */
  /* Remuxer                                                             */
  /* ------------------------------------------------------------------ */

  class Mp4Remuxer {
    constructor() {
      this.ts = { pmtPid: null, videoPid: null, audioPid: null, unsupported: null };
      this.sps = null; this.pps = null; this.spsInfo = null;
      this.audioConfig = null; // {objectType, rateIndex, rate, channels}
      this.segments = [];       // {start, video:{samples,blob}, audio:{frames,blob}}
      this.offset = null;       // desplazamiento actual (ticks 90 kHz) a la línea continua
      this.lastVideoEnd = null; // fin del último cuadro de video en la línea continua
      this.lastVideoDur = 3600;
      this.audioCarry = null;   // bytes ADTS partidos entre PES
      this.audioNextPts = null;
      this.discontinuities = 0;
      this.warnings = [];
    }

    /**
     * Agrega un segmento TS. `start` es su tiempo en la playlist (segundos).
     * Debe llamarse en orden de reproducción.
     */
    addSegment(bytes, start = 0) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      this.audioCarry = null; // las tramas ADTS no cruzan segmentos HLS
      const { video, audio } = demuxTs(bytes, this.ts);
      if (this.ts.unsupported && !this.ts.videoPid) throw new RemuxError(`Códec no compatible (${this.ts.unsupported}).`);

      const vs = this._videoSamples(video);
      const as = this._audioFrames(audio);
      if (!vs.length && !as.length) return; // segmento vacío

      // --- Línea de tiempo continua -------------------------------------
      if (this.offset === null) {
        const first = Math.min(vs.length ? vs[0].dts : Infinity, as.length ? as[0].pts : Infinity);
        this.offset = -first;
      } else if (vs.length) {
        const expected = this.lastVideoEnd;
        const actual = vs[0].dts + this.offset;
        // Saltos de más de medio segundo = reinicio de timestamps (otro archivo).
        if (Math.abs(actual - expected) > TS / 2) {
          this.offset = expected - vs[0].dts;
          this.discontinuities++;
        }
      }
      for (const s of vs) { s.dts += this.offset; s.pts += this.offset; }
      for (const f of as) f.pts += this.offset;

      // Duraciones de video (la del último cuadro se completa con el siguiente segmento).
      for (let i = 0; i < vs.length - 1; i++) vs[i].dur = Math.max(1, vs[i + 1].dts - vs[i].dts);
      const prevSeg = this._lastSegmentWithVideo();
      if (prevSeg && vs.length) {
        const last = prevSeg.video.samples[prevSeg.video.samples.length - 1];
        const d = vs[0].dts - last.dts;
        last.dur = d > 0 && d < TS ? d : this.lastVideoDur;
      }
      if (vs.length) {
        const last = vs[vs.length - 1];
        const typical = vs.length > 1 ? vs[vs.length - 2].dur : this.lastVideoDur;
        last.dur = typical;
        this.lastVideoDur = typical;
        this.lastVideoEnd = last.dts + last.dur;
      }

      // Tiempo en la playlist (para recortar con precisión): relativo al segmento.
      for (const s of vs) s.time = start + (s.pts - (vs[0].pts)) / TS;
      const aRef = vs.length ? vs[0].pts : (as.length ? as[0].pts : 0);
      for (const f of as) f.time = start + (f.pts - aRef) / TS;

      // Datos → Blob (fuera del heap de JS).
      const seg = { start, video: null, audio: null };
      if (vs.length) {
        let off = 0;
        for (const s of vs) { s.offset = off; off += s.size; }
        seg.video = { samples: vs, blob: new Blob(vs.map(s => s.data)), size: off };
        for (const s of vs) delete s.data;
      }
      if (as.length) {
        let off = 0;
        for (const f of as) { f.offset = off; off += f.size; }
        seg.audio = { frames: as, blob: new Blob(as.map(f => f.data)), size: off };
        for (const f of as) delete f.data;
      }
      this.segments.push(seg);
    }

    _lastSegmentWithVideo() {
      for (let i = this.segments.length - 1; i >= 0; i--) if (this.segments[i].video) return this.segments[i];
      return null;
    }

    _videoSamples(pesList) {
      const samples = [];
      let base = null;
      for (const pes of pesList) {
        const nals = splitNals(pes.payload);
        const keep = [];
        let key = false;
        for (const nal of nals) {
          const type = nal[0] & 0x1f;
          if (type === 7) {
            if (!this.sps) { this.sps = nal.slice(); this.spsInfo = parseSps(nal); }
            else if (!bytesEqual(nal, this.sps)) keep.push(nal); // SPS distinto: se conserva en banda
            continue;
          }
          if (type === 8) {
            if (!this.pps) this.pps = nal.slice();
            else if (!bytesEqual(nal, this.pps)) keep.push(nal);
            continue;
          }
          if (type === 9 || type === 12) continue; // AUD / relleno
          if (type === 5) key = true;
          keep.push(nal);
        }
        const hasSlice = keep.some(n => { const t = n[0] & 0x1f; return t >= 1 && t <= 5; });
        if (pes.pts === null) {
          // Continuación de la unidad de acceso anterior.
          const prev = samples[samples.length - 1];
          if (prev && keep.length) { prev.nals.push(...keep); prev.key = prev.key || key; }
          continue;
        }
        if (!hasSlice && !keep.length) continue;
        const dts = unwrap(pes.dts, base);
        const pts = unwrap(pes.pts, dts);
        if (base === null) base = dts;
        samples.push({ dts, pts, key, nals: keep });
      }
      for (const s of samples) {
        let size = 0;
        for (const n of s.nals) size += 4 + n.length;
        const data = new Uint8Array(size);
        const dv = new DataView(data.buffer);
        let o = 0;
        for (const n of s.nals) { dv.setUint32(o, n.length); data.set(n, o + 4); o += 4 + n.length; }
        s.data = data; s.size = size; delete s.nals;
      }
      // Orden de decodificación estricto.
      for (let i = 1; i < samples.length; i++) if (samples[i].dts <= samples[i - 1].dts) samples[i].dts = samples[i - 1].dts + 1;
      return samples.filter(s => s.size > 0);
    }

    _audioFrames(pesList) {
      const frames = [];
      let base = null;
      for (const pes of pesList) {
        let data = pes.payload;
        let pts = pes.pts !== null ? unwrap(pes.pts, base ?? this.audioNextPts) : this.audioNextPts;
        if (this.audioCarry) {
          const merged = new Uint8Array(this.audioCarry.length + data.length);
          merged.set(this.audioCarry); merged.set(data, this.audioCarry.length);
          data = merged;
          if (this.audioNextPts !== null && pes.pts !== null) {
            pts = this.audioNextPts; // la trama partida comenzó en el PES anterior
          }
          this.audioCarry = null;
        }
        if (pts === null || pts === undefined) continue;
        if (base === null) base = pts;
        let i = 0;
        while (i + 7 <= data.length) {
          if (data[i] !== 0xff || (data[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
          const protectionAbsent = data[i + 1] & 1;
          const objectType = ((data[i + 2] >> 6) & 3) + 1;
          const rateIndex = (data[i + 2] >> 2) & 0x0f;
          const channels = ((data[i + 2] & 1) << 2) | (data[i + 3] >> 6);
          const len = ((data[i + 3] & 3) << 11) | (data[i + 4] << 3) | (data[i + 5] >> 5);
          const blocks = (data[i + 6] & 3) + 1;
          const header = protectionAbsent ? 7 : 9;
          if (len < header || rateIndex >= AAC_RATES.length) { i++; continue; }
          if (i + len > data.length) { this.audioCarry = data.slice(i); break; }
          if (!this.audioConfig) this.audioConfig = { objectType, rateIndex, rate: AAC_RATES[rateIndex], channels: channels || 2 };
          const frameDur = 1024 * TS / this.audioConfig.rate;
          if (blocks === 1) {
            const raw = data.slice(i + header, i + len);
            frames.push({ pts, size: raw.length, data: raw });
            pts += frameDur;
          } else {
            // Raro: varias tramas crudas en un ADTS. Se reparte por igual.
            const raw = data.subarray(i + header, i + len);
            const step = Math.floor(raw.length / blocks);
            for (let b = 0; b < blocks; b++) {
              const part = raw.slice(b * step, b === blocks - 1 ? raw.length : (b + 1) * step);
              frames.push({ pts, size: part.length, data: part });
              pts += frameDur;
            }
          }
          i += len;
        }
        // pts actual = estimación del inicio de la próxima trama
        this.audioNextPts = pts;
      }
      // Si el PES siguiente trae un PTS propio, la continuidad se recalcula ahí.
      return frames;
    }

    /** Información del contenido agregado hasta ahora. */
    info() {
      const vs = this.segments.filter(s => s.video);
      const first = vs[0]?.video.samples[0];
      const lastSeg = vs[vs.length - 1];
      const last = lastSeg?.video.samples[lastSeg.video.samples.length - 1];
      return {
        width: this.spsInfo?.width || 0,
        height: this.spsInfo?.height || 0,
        audio: this.audioConfig,
        start: first?.time ?? 0,
        end: last ? last.time + last.dur / TS : 0,
        discontinuities: this.discontinuities
      };
    }

    /**
     * Genera el MP4. `range` opcional {start, end} en segundos de la playlist:
     * se empieza en el último cuadro clave ≤ start y se termina en end.
     * Devuelve {blob, duration, start, end, videoSamples, audioSamples}.
     */
    finalize(range = {}) {
      if (!this.sps || !this.pps) throw new RemuxError('No se encontró video H.264 en los segmentos.');
      // ---- 1. Selección de muestras de video --------------------------
      const vlist = [];
      for (const seg of this.segments) if (seg.video) for (const s of seg.video.samples) vlist.push({ s, seg });
      if (!vlist.length) throw new RemuxError('No hay cuadros de video.');
      let first = vlist.findIndex(x => x.s.key);
      if (first < 0) throw new RemuxError('No se encontró ningún cuadro clave.');
      if (Number.isFinite(range.start)) {
        for (let i = first; i < vlist.length; i++) {
          if (vlist[i].s.time > range.start + 1e-3) break;
          if (vlist[i].s.key) first = i;
        }
      }
      let last = vlist.length - 1;
      if (Number.isFinite(range.end)) {
        let lastPres = -1;
        for (let i = first; i < vlist.length; i++) if (vlist[i].s.time < range.end - 1e-3) lastPres = i;
        if (lastPres >= first) last = lastPres;
      }
      const vsel = vlist.slice(first, last + 1);
      const t0 = vsel[0].s.dts;                   // origen de la línea de tiempo de salida
      const minPts = Math.min(...vsel.slice(0, 64).map(x => x.s.pts));
      const videoEnd = vsel[vsel.length - 1].s.dts + vsel[vsel.length - 1].s.dur;

      // ---- 2. Audio alineado al video ---------------------------------
      const cfg = this.audioConfig;
      const asel = [];
      let drift = 0; // máxima diferencia entre la posición del audio y su PTS original
      if (cfg) {
        const frameDur = 1024 * TS / cfg.rate;
        const silent = SILENT_AAC[cfg.channels] && cfg.objectType === 2 ? new Uint8Array(SILENT_AAC[cfg.channels]) : null;
        let cursor = minPts; // el audio arranca junto con la primera imagen
        for (const seg of this.segments) {
          if (!seg.audio) continue;
          for (const f of seg.audio.frames) {
            if (f.pts + frameDur / 2 < cursor) continue;    // solapado o anterior al inicio
            if (f.pts >= videoEnd) break;
            const gap = f.pts - cursor;
            const n = Math.round(gap / frameDur);
            if (n >= 1) {
              // Hueco: rellenar con silencio (o estirar la trama previa si no hay silencio).
              // El error queda acotado a ±media trama y no se acumula.
              if (silent) for (let k = 0; k < n; k++) asel.push({ silent, size: silent.length });
              else if (asel.length) asel[asel.length - 1].extra = (asel[asel.length - 1].extra || 0) + n;
              cursor += n * frameDur;
            }
            drift = Math.max(drift, Math.abs(cursor - f.pts));
            asel.push({ f, seg, size: f.size });
            cursor += frameDur;
          }
        }
      }

      // ---- 3. Tablas -------------------------------------------------
      const vSamples = vsel.map(x => ({
        size: x.s.size, dur: x.s.dur, cts: x.s.pts - x.s.dts, key: x.s.key,
        seg: x.seg, offset: x.s.offset
      }));
      // La primera muestra comienza en 0; edit list compensa el retraso de B-frames.
      const shift = minPts - t0; // >0 cuando hay reordenamiento
      const videoDur = videoEnd - t0;
      const aRate = cfg ? cfg.rate : 0;
      const aSamples = asel.map(a => ({ size: a.size, dur: 1024 * (1 + (a.extra || 0)), ref: a }));
      const audioDur = aSamples.reduce((n, a) => n + a.dur, 0);

      // ---- 4. Chunks intercalados (~1 s cada uno) -----------------------
      const chunks = []; // {track, start, count, parts:[...]}
      const makeChunks = (samples, track, timescale) => {
        const list = [];
        let cur = null, t = 0;
        for (let i = 0; i < samples.length; i++) {
          const smp = samples[i];
          if (!cur || t - cur.t >= timescale || cur.count >= 1024) {
            cur = { track, first: i, count: 0, t, size: 0 };
            list.push(cur);
          }
          cur.count++; cur.size += smp.size; t += smp.dur;
        }
        return list;
      };
      const vChunks = makeChunks(vSamples, 1, TS);
      const aChunks = makeChunks(aSamples, 2, aRate || 1);
      // intercalar por tiempo
      let vi = 0, ai = 0;
      while (vi < vChunks.length || ai < aChunks.length) {
        const vt = vi < vChunks.length ? vChunks[vi].t / TS : Infinity;
        const at = ai < aChunks.length ? aChunks[ai].t / aRate : Infinity;
        if (vt <= at) chunks.push(vChunks[vi++]); else chunks.push(aChunks[ai++]);
      }
      const mdatPayload = chunks.reduce((n, c) => n + c.size, 0);
      const large = mdatPayload + 16 > 0xffffffff;
      const co64 = mdatPayload > 0xffffffff - 16777216;

      const width = this.spsInfo.width, height = this.spsInfo.height;
      const tracks = [{
        id: 1, kind: 'vide', timescale: TS, duration: videoDur, samples: vSamples, chunks: vChunks, shift, co64
      }];
      if (aSamples.length) tracks.push({ id: 2, kind: 'soun', timescale: aRate, duration: audioDur, samples: aSamples, chunks: aChunks, shift: 0, co64 });

      const ftyp = (() => {
        const w = new Writer(64);
        w.box('ftyp', () => { w.str('isom'); w.u32(0x200); w.str('isom'); w.str('iso2'); w.str('avc1'); w.str('mp41'); });
        return w.result();
      })();

      const buildMoov = baseOffset => {
        // offsets de chunks
        let off = baseOffset;
        for (const c of chunks) { c.fileOffset = off; off += c.size; }
        const w = new Writer(65536);
        const movieDur = Math.max(...tracks.map(t => Math.round(t.duration / t.timescale * 1000)));
        w.box('moov', () => {
          w.full('mvhd', 0, 0, () => {
            w.u32(0); w.u32(0); w.u32(1000); w.u32(movieDur);
            w.u32(0x00010000); w.u16(0x0100); w.zeros(10);
            for (const m of MATRIX) w.u32(m);
            w.zeros(24); w.u32(tracks.length + 1);
          });
          for (const t of tracks) this._trak(w, t, { width, height, movieDur });
        });
        return w.result();
      };
      // Primer pase para conocer el tamaño de moov; luego offsets definitivos.
      let moov = buildMoov(0);
      const mdatHeader = large ? 16 : 8;
      const base = ftyp.length + moov.length + mdatHeader;
      moov = buildMoov(base);
      if (ftyp.length + moov.length + mdatHeader !== base) throw new RemuxError('Error interno al calcular offsets.');

      const mdatHead = new Writer(16);
      if (large) { mdatHead.u32(1); mdatHead.str('mdat'); mdatHead.u64(mdatPayload + 16); }
      else { mdatHead.u32(mdatPayload + 8); mdatHead.str('mdat'); }

      // ---- 5. Partes del archivo (Blobs recortados, sin copiar) -----------
      const parts = [ftyp, moov, mdatHead.result()];
      for (const c of chunks) {
        if (c.track === 1) {
          // muestras consecutivas del mismo segmento → un slice
          let i = c.first;
          const endI = c.first + c.count;
          while (i < endI) {
            const seg = vSamples[i].seg;
            const from = vSamples[i].offset;
            let to = from + vSamples[i].size;
            let j = i + 1;
            while (j < endI && vSamples[j].seg === seg && vSamples[j].offset === to) { to += vSamples[j].size; j++; }
            parts.push(seg.video.blob.slice(from, to));
            i = j;
          }
        } else {
          let i = c.first;
          const endI = c.first + c.count;
          while (i < endI) {
            const a = aSamples[i].ref;
            if (a.silent) { parts.push(a.silent); i++; continue; }
            const seg = a.seg;
            const from = a.f.offset;
            let to = from + a.f.size;
            let j = i + 1;
            while (j < endI && !aSamples[j].ref.silent && aSamples[j].ref.seg === seg && aSamples[j].ref.f.offset === to) { to += aSamples[j].ref.f.size; j++; }
            parts.push(seg.audio.blob.slice(from, to));
            i = j;
          }
        }
      }
      const blob = new Blob(parts, { type: 'video/mp4' });
      return {
        blob,
        duration: videoDur / TS,
        start: vsel[0].s.time,
        end: vsel[vsel.length - 1].s.time + vsel[vsel.length - 1].s.dur / TS,
        videoSamples: vSamples.length,
        audioSamples: aSamples.length,
        width, height,
        audioDriftMs: Math.round(drift / 90),
        discontinuities: this.discontinuities
      };
    }

    _trak(w, t, { width, height, movieDur }) {
      const video = t.kind === 'vide';
      const trackDur = Math.round(t.duration / t.timescale * 1000);
      w.box('trak', () => {
        w.full('tkhd', 0, 3, () => {
          w.u32(0); w.u32(0); w.u32(t.id); w.u32(0); w.u32(trackDur);
          w.zeros(8); w.u16(0); w.u16(video ? 0 : 1); w.u16(video ? 0 : 0x0100); w.u16(0);
          for (const m of MATRIX) w.u32(m);
          w.u32(video ? width * 65536 : 0); w.u32(video ? height * 65536 : 0);
        });
        if (t.shift > 0) {
          // edit list: omite el retraso inicial de composición (B-frames)
          w.box('edts', () => w.full('elst', 0, 0, () => { w.u32(1); w.u32(trackDur); w.i32(t.shift); w.u32(0x00010000); }));
        }
        w.box('mdia', () => {
          w.full('mdhd', 0, 0, () => { w.u32(0); w.u32(0); w.u32(t.timescale); w.u32(Math.round(t.duration)); w.u16(0x55c4); w.u16(0); });
          w.full('hdlr', 0, 0, () => { w.u32(0); w.str(t.kind); w.zeros(12); w.str(video ? 'VideoHandler' : 'SoundHandler'); w.u8(0); });
          w.box('minf', () => {
            if (video) w.full('vmhd', 0, 1, () => w.zeros(8));
            else w.full('smhd', 0, 0, () => w.zeros(4));
            w.box('dinf', () => w.full('dref', 0, 0, () => { w.u32(1); w.full('url ', 0, 1, () => {}); }));
            w.box('stbl', () => this._stbl(w, t, { width, height }));
          });
        });
      });
      void movieDur;
    }

    _stbl(w, t, { width, height }) {
      const video = t.kind === 'vide';
      w.full('stsd', 0, 0, () => {
        w.u32(1);
        if (video) {
          w.box('avc1', () => {
            w.zeros(6); w.u16(1); w.zeros(16);
            w.u16(width); w.u16(height);
            w.u32(0x00480000); w.u32(0x00480000); w.u32(0); w.u16(1);
            w.zeros(32); w.u16(0x18); w.u16(0xffff);
            w.box('avcC', () => {
              const sps = this.sps, pps = this.pps;
              w.u8(1); w.u8(sps[1]); w.u8(sps[2]); w.u8(sps[3]); w.u8(0xff);
              w.u8(0xe1); w.u16(sps.length); w.bytes(sps);
              w.u8(1); w.u16(pps.length); w.bytes(pps);
              if ([100, 110, 122, 144].includes(sps[1])) { w.u8(0xfd); w.u8(0xf8); w.u8(0xf8); w.u8(0); }
            });
            const { sarW, sarH } = this.spsInfo;
            if (sarW !== sarH) w.box('pasp', () => { w.u32(sarW); w.u32(sarH); });
          });
        } else {
          const c = this.audioConfig;
          w.box('mp4a', () => {
            w.zeros(6); w.u16(1); w.zeros(8);
            w.u16(c.channels); w.u16(16); w.zeros(4);
            w.u32(Math.min(c.rate, 65535) * 65536);
            const asc = [(c.objectType << 3) | (c.rateIndex >> 1), ((c.rateIndex & 1) << 7) | (c.channels << 3)];
            const totalBytes = t.samples.reduce((n, s) => n + s.size, 0);
            const seconds = t.duration / t.timescale || 1;
            const avg = Math.round(totalBytes * 8 / seconds);
            const maxSize = t.samples.reduce((m, s) => Math.max(m, s.size), 0);
            w.full('esds', 0, 0, () => {
              // ES_Descriptor
              w.u8(0x03); w.u8(23 + asc.length); w.u16(t.id); w.u8(0);
              // DecoderConfigDescriptor
              w.u8(0x04); w.u8(15 + asc.length); w.u8(0x40); w.u8(0x15);
              w.u24(maxSize); w.u32(avg * 2); w.u32(avg);
              // DecoderSpecificInfo
              w.u8(0x05); w.u8(asc.length); w.bytes(asc);
              // SLConfigDescriptor
              w.u8(0x06); w.u8(1); w.u8(2);
            });
          });
        }
      });
      // stts (run-length)
      const stts = [];
      for (const s of t.samples) {
        const last = stts[stts.length - 1];
        if (last && last[1] === s.dur) last[0]++; else stts.push([1, s.dur]);
      }
      w.full('stts', 0, 0, () => { w.u32(stts.length); for (const [n, d] of stts) { w.u32(n); w.u32(d); } });
      if (video && t.samples.some(s => s.cts !== 0)) {
        const ctts = [];
        for (const s of t.samples) {
          const v = s.cts;
          const last = ctts[ctts.length - 1];
          if (last && last[1] === v) last[0]++; else ctts.push([1, v]);
        }
        w.full('ctts', 0, 0, () => { w.u32(ctts.length); for (const [n, v] of ctts) { w.u32(n); w.i32(v); } });
      }
      if (video) {
        const keys = [];
        t.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
        if (keys.length < t.samples.length) w.full('stss', 0, 0, () => { w.u32(keys.length); for (const k of keys) w.u32(k); });
      }
      // stsc
      const stsc = [];
      t.chunks.forEach((c, i) => {
        const last = stsc[stsc.length - 1];
        if (!last || last[1] !== c.count) stsc.push([i + 1, c.count]);
      });
      w.full('stsc', 0, 0, () => { w.u32(stsc.length); for (const [f, n] of stsc) { w.u32(f); w.u32(n); w.u32(1); } });
      w.full('stsz', 0, 0, () => { w.u32(0); w.u32(t.samples.length); for (const s of t.samples) w.u32(s.size); });
      if (t.co64) w.full('co64', 0, 0, () => { w.u32(t.chunks.length); for (const c of t.chunks) w.u64(c.fileOffset || 0); });
      else w.full('stco', 0, 0, () => { w.u32(t.chunks.length); for (const c of t.chunks) w.u32(c.fileOffset || 0); });
    }
  }

  const api = { Mp4Remuxer, RemuxError, _internal: { demuxTs, splitNals, parseSps } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BeelupMp4 = api;
})(typeof self !== 'undefined' ? self : this);
