// Writes a sample dataset to ./data-demo so you can try everything without a bank.
// Usage: node demo.js && DATA_DIR=data-demo node main.js
process.env.DATA_DIR ||= 'data-demo';
const r = require('./lib/demo').generate();
console.log(`Demo data written (${r.transactions} transactions). Run: DATA_DIR=${process.env.DATA_DIR} node main.js`);
