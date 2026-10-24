// Thin wrapper around the hledger CLI.
const { execFile } = require('child_process');
const { paths } = require('./config');

// Hand-written entries (manual.journal) may contain any characters: make sure hledger decodes them as UTF-8.
function utf8Env() {
  const e = { ...process.env };
  if (!/utf-?8/i.test(`${e.LC_ALL || ''}${e.LANG || ''}`)) e.LC_ALL = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return e;
}
function run(args) {
  return new Promise((resolve, reject) => {
    execFile('hledger', ['-f', paths.main, ...args], { maxBuffer: 128e6, env: utf8Env(), windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(err.code === 'ENOENT' ? 'hledger is not installed (https://hledger.org/install).' : (stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}
const json = async (args) => JSON.parse(await run([...args, '-O', 'json']));

/** Flat balance rows: [{ account, amounts: {COMMODITY: qty} }] */
async function balances(args) {
  const [rows] = await json(['bal', '--flat', '-N', ...args]);
  return rows.map(([account, , , amts]) => ({
    account,
    amounts: Object.fromEntries(amts.map((a) => [a.acommodity, a.aquantity.floatingPoint])),
  }));
}

module.exports = { run, json, balances };
