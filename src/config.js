const fs = require('fs')
const path = require('path')

var filename = path.join(__dirname, '..', 'config', 'snakepit.config')
try {
    module.exports = JSON.parse(fs.readFileSync(filename, 'utf8'))
} catch (err) {
    console.error('Unable to load configuration from ""' + filename + '"')
}

