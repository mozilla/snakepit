const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

var filename = path.join(__dirname, '..', 'config', 'snakepit.conf')
try {
    module.exports = yaml.safeLoad(fs.readFileSync(filename, 'utf8'));
} catch (err) {
    console.error(err);
}
