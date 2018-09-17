const fs = require('fs')
const path = require('path')
const stream = require('stream')
const { spawn } = require('child_process')

var exports = module.exports = {}

exports.getDuration = function(date1, date2) {
    let delta = Math.abs(date2 - date1) / 1000
    let days = Math.floor(delta / 86400)
    delta -= days * 86400
    let hours = Math.floor(delta / 3600) % 24
    delta -= hours * 3600
    let minutes = Math.floor(delta / 60) % 60
    delta -= minutes * 60
    let seconds = Math.floor(delta % 60)
    return {
        days: days,
        hours: hours,
        minutes: minutes,
        seconds: seconds
    }
}

exports.shellQuote = function(str) {
    str = '' + str
    str = str.replace(/\\/g, '\\\\')
    str = str.replace(/\'/g, '\\\'')
    str = str.replace(/(?:\r\n|\r|\n)/g, '\\n')
    str = '$\'' + str + '\''
    return str
}

var _loadedScripts = {}

const _includePrefix = '#INCLUDE '

function _getScript(scriptName, alreadyIncluded) {
    if (alreadyIncluded.hasOwnProperty(scriptName)) {
        return ''
    }
    if (_loadedScripts.hasOwnProperty(scriptName)) {
        return _loadedScripts[scriptName]
    }
    let scriptPath = path.join(__dirname, '..', 'scripts', scriptName)
    let script = fs.readFileSync(scriptPath).toString()
    alreadyIncluded[scriptName] = true
    script = script
        .split('\n')
        .map(
            l => l.startsWith(_includePrefix) ? 
                _getScript(l.substring(_includePrefix.length), alreadyIncluded) : 
                l
        )
        .join('\n')
    return _loadedScripts[scriptName] = script
}

exports.getScript = function(scriptName) {
    return _getScript(scriptName, {})
}

exports.runScript = function(scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    env = env || {}
    let script = _getScript(scriptName, {})
    //console.log('Running script "' + scriptPath + '"')
    p = spawn('bash', ['-s'])
    let stdout = []
    p.stdout.on('data', data => stdout.push(data))
    let stderr = []
    p.stderr.on('data', data => stderr.push(data))
    let called = false
    let callCallback = code => {
        if (!called) {
            called = true
            callback(code, stdout.join('\n'), stderr.join('\n'))
        }
    }
    p.on('close', code => callCallback(code))
    p.on('error', err => callCallback(128))
    p.on('exit', code => callCallback(code || 0))
    var stdinStream = new stream.Readable()
    Object.keys(env).forEach(name => stdinStream.push(
        'export ' + name + '=' + exports.shellQuote(env[name]) + '\n')
    )
    stdinStream.push(script + '\n')
    stdinStream.push(null)
    stdinStream.pipe(p.stdin)
    return p
}