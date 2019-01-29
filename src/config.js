const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const parseDuration = require('parse-duration')

const oneSecond = 1000
const oneMinute = 60 * oneSecond
const oneHour = 60 * oneMinute
const oneDay = 24 * oneHour

var filename = process.env.SNAKEPIT_CONF || '/etc/snakepit/snakepit.conf'
if (!fs.existsSync(filename)) {
    if (process.env.HOME) {
        filename = path.join(process.env.HOME, '.snakepit', 'snakepit.conf')
    } else {
        filename = path.join('config', 'snakepit.conf')
    }
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
var config = module.exports = tryConfigFile(() => yaml.safeLoad(content), 'parsing')

function readConfigFile(name, mandatory) {
    if (fs.existsSync(config[name])) {
        return fs.readFileSync(config[name]).toString()
    } else if (mandatory) {
        throw new Error('Unable to read mandatory config file: ' + name)
    }
}

config.interface        = process.env.SNAKEPIT_INTERFACE   || config.interface || '0.0.0.0'
config.port             = process.env.SNAKEPIT_PORT        || config.port      || 80

config.logLevel         = typeof config.logLevel === 'undefined' ? 1 : Number(config.logLevel)
config.debugHttp        = process.env.SNAKEPIT_DEBUG_HTTP  || config.debugHttp
config.debugJobFS       = process.env.SNAKEPIT_DEBUG_JOBFS || config.debugJobFS

config.tokenSecret      = readConfigFile('tokenSecretPath', true)
config.tokenTTL         = parseDuration(config.tokenTTL || '1d')
config.hashRounds       = config.hashRounds || 10

if (!config.endpoint) {
    throw new Error('Missing field: endpoint')
}
config.clientKey        = readConfigFile('clientKey', true)
config.clientCert       = readConfigFile('clientCert', true)
config.containerTimeout = parseDuration(config.timeout || '30s')

config.pollInterval     = config.pollInterval     ? Number(config.pollInterval)    : oneSecond
config.maxParallelPrep  = config.maxParallelPrep  ? Number(config.maxParallelPrep) : 2
config.maxPrepDuration  = parseDuration(config.maxPrepDuration  || '1h')
config.maxStartDuration = parseDuration(config.maxStartDuration || '5m')
config.lxdTimeout       = parseDuration(config.lxdTimeout       || '10s')

config.mountRoot        = config.mountRoot || '/snakepit'
