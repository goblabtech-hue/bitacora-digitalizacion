/* ══════════════════════════════════════════════════════════════════════
   Generador de códigos QR — nivel de corrección M, versiones 1 a 6.
   Sin dependencias. QR.matriz('texto') devuelve una matriz de 0 y 1.
   ══════════════════════════════════════════════════════════════════════ */
const QR = (() => {

  /* ── aritmética en el campo de Galois GF(256) ── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* ── parámetros por versión (nivel M) ── */
  const VERSIONES = {
    1: { total: 26,  ec: 10, bloques: 1, align: [] },
    2: { total: 44,  ec: 16, bloques: 1, align: [6, 18] },
    3: { total: 70,  ec: 26, bloques: 1, align: [6, 22] },
    4: { total: 100, ec: 18, bloques: 2, align: [6, 26] },
    5: { total: 134, ec: 24, bloques: 2, align: [6, 30] },
    6: { total: 172, ec: 16, bloques: 4, align: [6, 34] }
  };
  const datosDe = (v) => VERSIONES[v].total - VERSIONES[v].ec * VERSIONES[v].bloques;

  /* ── Reed-Solomon ── */
  function generador(grado) {
    let g = [1];
    for (let i = 0; i < grado; i++) {
      const nuevo = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        nuevo[j] ^= mul(g[j], EXP[i]);
        nuevo[j + 1] ^= g[j];
      }
      g = nuevo;
    }
    return g;
  }
  function correccion(datos, grado) {
    // el generador se construye en orden ascendente; la división lo necesita
    // en orden descendente y sin el término líder
    const coef = generador(grado).slice(0, grado).reverse();
    const resto = new Array(grado).fill(0);
    for (const byte of datos) {
      const factor = byte ^ resto.shift();
      resto.push(0);
      for (let i = 0; i < grado; i++) resto[i] ^= mul(coef[i], factor);
    }
    return resto;
  }

  /* ── flujo de bits del mensaje ── */
  function codificar(texto) {
    const bytes = [...new TextEncoder().encode(texto)];
    let version = 0;
    for (let v = 1; v <= 6; v++) {
      if (bytes.length + 2 <= datosDe(v)) { version = v; break; }
    }
    if (!version) throw new Error('El texto es demasiado largo para un QR versión 6.');

    const capacidad = datosDe(version);
    const bits = [];
    const empujar = (valor, ancho) => {
      for (let i = ancho - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
    };

    empujar(0b0100, 4);           // modo byte
    empujar(bytes.length, 8);     // contador (versiones 1-9)
    bytes.forEach((b) => empujar(b, 8));

    for (let i = 0; i < 4 && bits.length < capacidad * 8; i++) bits.push(0);  // terminador
    while (bits.length % 8) bits.push(0);

    const palabras = [];
    for (let i = 0; i < bits.length; i += 8) {
      palabras.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    }
    for (let i = 0; palabras.length < capacidad; i++) palabras.push(i % 2 ? 0x11 : 0xec);

    /* bloques + intercalado */
    const { bloques, ec } = VERSIONES[version];
    const largo = capacidad / bloques;
    const datos = [], eccs = [];
    for (let b = 0; b < bloques; b++) {
      const bloque = palabras.slice(b * largo, (b + 1) * largo);
      datos.push(bloque);
      eccs.push(correccion(bloque, ec));
    }
    const salida = [];
    for (let i = 0; i < largo; i++) for (const b of datos) salida.push(b[i]);
    for (let i = 0; i < ec; i++)    for (const e of eccs)  salida.push(e[i]);

    return { version, palabras: salida };
  }

  /* ── construcción de la matriz ── */
  function construir(version, palabras) {
    const tam = version * 4 + 17;
    const mod = Array.from({ length: tam }, () => new Array(tam).fill(0));
    const fun = Array.from({ length: tam }, () => new Array(tam).fill(false));
    const set = (x, y, v) => { mod[y][x] = v ? 1 : 0; fun[y][x] = true; };

    // patrones de sincronía (los localizadores se dibujan encima)
    for (let i = 0; i < tam; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // patrones localizadores y separadores
    const localizador = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < tam && y >= 0 && y < tam) set(x, y, d !== 2 && d !== 4);
      }
    };
    localizador(3, 3); localizador(tam - 4, 3); localizador(3, tam - 4);

    // patrones de alineación
    const pos = VERSIONES[version].align;
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // reserva del área de formato
    formato(mod, fun, tam, 0, true);

    // colocación de los datos en zigzag
    let i = 0;
    for (let der = tam - 1; der >= 1; der -= 2) {
      if (der === 6) der = 5;
      for (let v = 0; v < tam; v++) {
        for (let j = 0; j < 2; j++) {
          const x = der - j;
          const arriba = ((der + 1) & 2) === 0;
          const y = arriba ? tam - 1 - v : v;
          if (!fun[y][x] && i < palabras.length * 8) {
            mod[y][x] = (palabras[i >>> 3] >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
    return { mod, fun, tam };
  }

  function formato(mod, fun, tam, mascara, soloReserva) {
    const datos = (0b00 << 3) | mascara;          // nivel M = 00
    let resto = datos;
    for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
    const bits = ((datos << 10) | resto) ^ 0x5412;
    const bit = (i) => soloReserva ? 0 : (bits >>> i) & 1;
    const set = (x, y, v) => { mod[y][x] = v; fun[y][x] = true; };

    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) set(tam - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, tam - 15 + i, bit(i));
    set(8, tam - 8, 1);                            // módulo oscuro
  }

  const MASCARAS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ];

  /* ── penalización (reglas 1 a 4 de la norma) ── */
  function penalizacion(mod, tam) {
    let p = 0;
    const FALSO = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const linea = (obtener) => {
      let corrida = 1, oscuros = 0;
      const buffer = [];
      for (let i = 0; i < tam; i++) {
        const v = obtener(i);
        buffer.push(v);
        if (i > 0 && v === obtener(i - 1)) { corrida++; if (corrida === 5) p += 3; else if (corrida > 5) p += 1; }
        else corrida = 1;
      }
      for (let i = 0; i + 11 <= tam; i++) {
        const trozo = buffer.slice(i, i + 11);
        if (trozo.every((v, k) => v === FALSO[k]) || trozo.every((v, k) => v === FALSO[10 - k])) p += 40;
      }
      return oscuros;
    };
    for (let r = 0; r < tam; r++) linea((i) => mod[r][i]);
    for (let c = 0; c < tam; c++) linea((i) => mod[i][c]);

    for (let r = 0; r < tam - 1; r++) for (let c = 0; c < tam - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) p += 3;
    }

    let oscuros = 0;
    for (let r = 0; r < tam; r++) for (let c = 0; c < tam; c++) oscuros += mod[r][c];
    const desvio = Math.abs(oscuros * 20 - tam * tam * 10) / (tam * tam);
    p += Math.floor(desvio) * 10;
    return p;
  }

  /* ── API pública ── */
  function matriz(texto) {
    const { version, palabras } = codificar(String(texto));
    const base = construir(version, palabras);
    let mejor = null, mejorP = Infinity;

    for (let m = 0; m < 8; m++) {
      const mod = base.mod.map((f) => f.slice());
      for (let r = 0; r < base.tam; r++) for (let c = 0; c < base.tam; c++) {
        if (!base.fun[r][c] && MASCARAS[m](r, c)) mod[r][c] ^= 1;
      }
      formato(mod, base.fun.map((f) => f.slice()), base.tam, m, false);
      const p = penalizacion(mod, base.tam);
      if (p < mejorP) { mejorP = p; mejor = mod; }
    }
    return mejor;
  }

  /* Devuelve un <svg> listo para insertar. */
  function svg(texto, { modulo = 4, margen = 4, color = '#000' } = {}) {
    const m = matriz(texto);
    const tam = m.length;
    const lado = (tam + margen * 2) * modulo;
    let ruta = '';
    for (let r = 0; r < tam; r++) for (let c = 0; c < tam; c++) {
      if (m[r][c]) ruta += `M${(c + margen) * modulo} ${(r + margen) * modulo}h${modulo}v${modulo}h-${modulo}z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}" role="img" aria-label="Código QR ${texto}">
      <rect width="${lado}" height="${lado}" fill="#fff"/><path d="${ruta}" fill="${color}"/></svg>`;
  }

  return { matriz, svg };
})();

if (typeof module !== 'undefined') module.exports = QR;
