// Almacenamiento de datos en un archivo JSON local, con respaldos diarios.
// Todas las escrituras pasan por mutate(), que corre de forma sincrónica:
// como Node atiende una petición a la vez, dos gastos guardados al mismo
// tiempo nunca se pisan.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const DATA_FILE = path.join(DATA_DIR, 'gastos.json');
export const BACKUP_DIR = path.join(DATA_DIR, 'respaldos');
const BACKUPS_TO_KEEP = 30;

const EMPTY = () => ({ version: 1, sessions: [], categories: [], expenses: [] });

let state = null;

export function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } else {
    state = EMPTY();
    save();
  }
  return state;
}

export function get() {
  return state;
}

export function save() {
  const json = JSON.stringify(state, null, 2);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, DATA_FILE);
  } catch {
    // En Windows un antivirus puede bloquear el reemplazo; escribimos directo.
    fs.writeFileSync(DATA_FILE, json);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function mutate(fn) {
  const result = fn(state);
  save();
  return result;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Copia el archivo de datos a data/respaldos/gastos-AAAA-MM-DD.json
// y conserva solo los últimos 30 respaldos.
export function backup() {
  if (!fs.existsSync(DATA_FILE)) return null;
  const name = `gastos-${today()}.json`;
  fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^gastos-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - BACKUPS_TO_KEEP))) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
  }
  return name;
}

// Copia de los datos sin las sesiones abiertas, para descargar.
export function exportable() {
  return {
    exportado: new Date().toISOString(),
    categories: state.categories,
    expenses: state.expenses,
  };
}
