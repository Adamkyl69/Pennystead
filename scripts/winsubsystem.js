// Marks a Windows .exe as a windowed (GUI) program instead of a console program, so double-clicking Pennystead
// does not open a cmd window next to it. Only one field of the PE header changes. Programs that start Pennystead with
// pipes (AI apps using --mcp, the smoke test, the updater) still get its output.
const fs = require('fs');

const GUI = 2, CONSOLE = 3;
/** Patches the buffer in place; returns the previous subsystem value. */
function setSubsystem(buf, value = GUI) {
  if (buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a Windows executable (no MZ header).');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a Windows executable (no PE header).');
  const opt = pe + 24, magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Unknown PE optional header.');
  const at = opt + 68; // Subsystem: same offset in PE32 and PE32+
  const before = buf.readUInt16LE(at);
  if (before !== GUI && before !== CONSOLE) throw new Error(`Unexpected subsystem ${before}.`);
  buf.writeUInt16LE(value, at);
  return before;
}
function makeGui(file) { const b = fs.readFileSync(file); setSubsystem(b, GUI); fs.writeFileSync(file, b); }

module.exports = { setSubsystem, makeGui, GUI, CONSOLE };
