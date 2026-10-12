// The packaged build injects __PENNYSTEAD_VERSION__; from source we read package.json.
/* global __PENNYSTEAD_VERSION__ */
module.exports = typeof __PENNYSTEAD_VERSION__ !== 'undefined' ? __PENNYSTEAD_VERSION__ : require('../package.json').version;
