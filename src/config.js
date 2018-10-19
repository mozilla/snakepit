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

function readConfigFile(name) {
    return fs.existsSync(config[name]) ? fs.readFileSync(config[name]) : undefined
}

config.tokenSecret = readConfigFile('tokenSecretPath')

config.key = readConfigFile('keyPemPath')
config.cert = readConfigFile('certPemPath')
config.https = config.key

config.interface  = process.env.SNAKEPIT_INTERFACE   || config.interface || '0.0.0.0'
config.port       = process.env.SNAKEPIT_PORT        || config.port      || (config.https ? 443 : 80)
config.external   = process.env.SNAKEPIT_EXTERNAL    || config.external  || ('https://' + config.fqdn + ':' + config.port)

config.debugHttp  = process.env.SNAKEPIT_DEBUG_HTTP  || config.debugHttp
config.debugJobFS = process.env.SNAKEPIT_DEBUG_JOBFS || config.debugJobFS

config.pollInterval      = config.pollInterval     ? Number(config.pollInterval)            : oneSecond
config.maxParallelPrep   = config.maxParallelPrep  ? Number(config.maxParallelPrep)         : 2
config.keepDoneDuration  = config.keepDoneDuration ? parseDuration(config.keepDoneDuration) : 7 * oneDay
config.maxPrepDuration   = config.maxPrepDuration  ? parseDuration(config.maxPrepDuration)  : oneHour
config.maxStartDurationn = config.maxStartDuration ? parseDuration(config.maxStartDuration) : 5 * oneMinute

config.dataRoot  = config.dataRoot  || '/snakepit'
config.jobsDir   = config.jobsDir   || path.join(config.dataRoot, 'jobs')
config.sharedDir = config.sharedDir || path.join(config.dataRoot, 'shared')
config.groupsDir = config.groupsDir || path.join(config.dataRoot, 'groups')
config.homesDir  = config.homesDir  || path.join(config.dataRoot, 'home')
config.uploadDir = config.uploadDir || path.join(config.dataRoot, 'uploads')
