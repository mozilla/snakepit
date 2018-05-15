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

exports.runForEach = function(col, fun, callback) {
    let counter = col.length
    let done = () => {
        counter--
        if (counter == 0) {
            callback()
        }
    }
    if (col.length > 0) {
        for(let item of col) {
            fun(item, done)
        }
    } else {
        callback()
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

exports.runScript = function(scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    let scriptPath = path.join(__dirname, '..', 'scripts', scriptName)
    fs.readFile(scriptPath, function read(err, content) {
        if (err) {
            callback(1, '', 'Problem reading script "' + scriptPath + '"')
        } else {
            env = env || {}
            //console.log('Running script "' + scriptPath + '"')
            p = spawn('bash', ['-s'])
            let stdout = []
            p.stdout.on('data', data => stdout.push(data))
            let stderr = []
            p.stderr.on('data', data => stderr.push(data))
            p.on('close', code => callback(code, stdout.join('\n'), stderr.join('\n')))
            var stdinStream = new stream.Readable()
            Object.keys(env).forEach(name => stdinStream.push(
                'export ' + name + '=' + exports.shellQuote(env[name]) + '\n')
            )
            stdinStream.push(content + '\n')
            stdinStream.push(null)
            stdinStream.pipe(p.stdin)
        }
    })
}

exports.getField = function(db, table, id, field, callback) {
    db.get('SELECT $field AS Result FROM $table WHERE id==$id', { 
        $table: table,
        $id: id,
        $field: field
    }, (err, result) => {
        callback(result && result.Result)
    })
}

exports.exists = function(db, table, id, callback) {
    db.get('SELECT COUNT(*) AS Result FROM $table WHERE id==$id', { 
        $table: table,
        $id: id
    }, (err, result) => {
        callback(result && result.Result > 0)
    })
}