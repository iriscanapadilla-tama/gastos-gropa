// Lee la configuración del servidor: datos/config.json
// Este archivo vive solo en el servidor, nunca en GitHub
// (por eso en el repositorio solo está config.ejemplo.json).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let cache = { mtime: 0, value: null };

export function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { missing: true, usuarios: [], firebase: {} };
  const mtime = fs.statSync(CONFIG_FILE).mtimeMs;
  if (cache.value && cache.mtime === mtime) return cache.value;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return { invalid: `config.json tiene un error de formato: ${e.message}`, usuarios: [], firebase: {} }; }
  const value = {
    firebase: raw.firebase || {},
    usuarios: (raw.usuarios || [])
      .filter((u) => u && u.correo && u.nombre)
      .map((u) => ({ id: String(u.correo).trim().toLowerCase(), displayName: String(u.nombre).trim() })),
    proyectoFirebaseAnterior: raw.proyectoFirebaseAnterior || 'gastos-gropa',
  };
  cache = { mtime, value };
  return value;
}

export function firebaseReady(cfg) {
  const f = cfg.firebase || {};
  return Boolean(f.apiKey && f.projectId && f.authDomain && !String(f.apiKey).includes('PEGA_AQUI'));
}
