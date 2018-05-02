const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

var filename = path.join(__dirname, '..', 'config', 'snakepit.conf')
var content
try {
    content = fs.readFileSync(filename, 'utf8')
} catch (err) {
    console.error('Unable to load config file from "' + filename + '"')
}
try {
    module.exports = yaml.safeLoad(content);
} catch (err) {
    console.error('Unable to parse content of config file "' + filename + '"')
}
