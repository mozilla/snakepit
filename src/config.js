const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

var filename = process.env.SNAKEPIT_CONF || '/etc/snakepit.conf'
if (!fs.existsSync(filename)) {
    filename = path.join(process.env.HOME, '.snakepit', 'snakepit.conf')
}

function tryConfigFile(fun, verb) {
    try {
        return fun()
    } catch (err) {
        console.error('Problem ' + verb + ' config file "' + filename + '"')
        process.exit(1)
    }
}

var content = tryConfigFile(() => fs.readFileSync(filename), 'reading')
module.exports = tryConfigFile(() => yaml.safeLoad(content), 'parsing')
