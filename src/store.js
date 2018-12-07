const fs = require('fs')
const path = require('path')
const cluster = require('cluster')
const config = require('./config.js')

var exports = module.exports = {}

const PARENT_SYMBOL = Symbol('parent')
const NAME_SYMBOL = Symbol('name')
const DB_PATH = '/data/db.json'

var rawRoot = (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).isFile()) ? JSON.parse(fs.readFileSync(DB_PATH).toString()) : {}
var storeLog = []
var locks = {}
var callbackIdCounter = 0
var callbacks = {}

_parentify(rawRoot, null, '')

function log(msg) {
    var entity = cluster.worker ? ('Worker ' + cluster.worker.id) : 'Master'
    console.log(entity + ': ' + msg)
}

function _broadcast(msg, skip_worker) {
    //log('sending message:' + JSON.stringify(msg))
    if (cluster.isMaster) {
        storeLog.push(msg)
        for(var wid in cluster.workers) {
            var worker = cluster.workers[wid]
            if (worker !== skip_worker)
                worker.send(msg)
        }
    } else {
        process.send(msg)
    }
}

function _getPath(obj) {
    if(!obj) return ''
    var parent = obj[PARENT_SYMBOL]
    var name = obj[NAME_SYMBOL]
    var path = _getPath(parent)
    return path.length > 0 ? (path + '.' + name) : name
}

function _getObject(path) {
    var obj = rawRoot
    path.split('.').filter(x => x).forEach(name => { obj = obj[name] })
    return obj
}

function _parentify(obj, parent, name) {
    obj[PARENT_SYMBOL] = parent
    obj[NAME_SYMBOL] = name
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) {
            var v = obj[k]
            if (typeof(v) === 'object' && v !== null)
                _parentify(v, obj, k)
        }
    }
}

var observer = {
    get: function(target, name) {
        value = target[name]
        return (typeof(value) === 'object' && value !== null) ? new Proxy(value, observer) : value
    },
    set: function(target, name, value) {
        var path = _getPath(target)
        var value_str = JSON.stringify(value)
        if(typeof(value) === 'object' && value !== null) {
            value = JSON.parse(value_str)
            _parentify(value, target, name)
        }
        //log('Setting property "' + name + '" of object "' + path + '" to value "' + value_str + '"')
        if (this != 'skip') {
            _broadcast({ storeOperation: 'set', path: path, args: [name, value] })
        }
        return Reflect.set(target, name, value)
    },
    deleteProperty: function(target, name) {
        var path = _getPath(target)
        //log('Deleting property "' + name + '" of object "' + path + '"')
        if (this != 'skip') {
            _broadcast({ storeOperation: 'deleteProperty', path: path, args: [name] })
        }
        return Reflect.deleteProperty(...arguments)
    }
}

function _send(recipient, msg) {
    if (recipient) {
        recipient.send(msg)
    } else if (cluster.isMaster) {
        _handle_message(msg, null)
    } else {
        process.send(msg)
    }
}

function _handle_message(msg, sender) {
    //log('Got a message ' + JSON.stringify(msg))
    if (msg.storeOperation) {
        observer[msg.storeOperation].apply('skip', [_getObject(msg.path)].concat(msg.args))
        if (cluster.isMaster) {
            _broadcast(msg, sender)
        }
    } else if (msg.askLock) {
        var waiting = locks[msg.askLock]
        var entry = { sender: sender, id: msg.id }
        if (waiting && waiting.length > 0) {
            waiting.push(entry)
        } else {
            locks[msg.askLock] = [entry]
            _send(sender, { gotLock: msg.askLock, id: msg.id })
        }
        //log('asked for lock')
    } else if (msg.gotLock) {
        var callback = callbacks[msg.id]
        delete callbacks[msg.id]
        if (callback.sync) {
            try {
                callback.fun()
            } finally {
                _send(sender, { freeLock: msg.gotLock })
            }
        } else {
            callback.fun(function() {
                _send(sender, { freeLock: msg.gotLock })
            })
        }
        //log('got lock')
    } else if (msg.freeLock) {
        var waiting = locks[msg.freeLock]
        if (waiting && waiting.length > 0) {
            waiting.shift()
        }
        if (waiting && waiting.length > 0) {
            _send(waiting[0].sender, { gotLock: msg.freeLock, id: waiting[0].id })
        }
        //log('freed lock')
    }
}

function _lock(target, callback, sync) {
    callbackIdCounter += 1
    callbacks[callbackIdCounter] = { fun: callback, sync: !!sync }
    _send(null, { askLock: target, id: callbackIdCounter })
}

function _writeDb() {
    if (storeLog.length > 0) {
        storeLog = []
        fs.writeFile(DB_PATH, JSON.stringify(rawRoot, null, '\t'), function(err) {
            if(err)
                return console.error(err);
            //log('Wrote db!')
        })
    }
}

function _tickOn() {
    setTimeout(_tick, 1000)
}

function _tick() {
    //console.log('Tick...')
    _writeDb()
    _tickOn()
}

if (cluster.isMaster) {
    cluster.on('fork', worker => {
        worker.on('message', msg => _handle_message(msg, worker))
        storeLog.forEach(msg => worker.send(msg))
    })
    cluster.on('exit', function(worker, code, signal) {
        for (let lockName in locks) {
            if (locks.hasOwnProperty(lockName)) {
                let waiting = locks[lockName]
                if (waiting && waiting.length > 0) {
                    let first = waiting[0]
                    locks[lockName] = waiting = waiting.filter(entry => entry.sender == worker)
                    if (waiting.length > 0 && first != waiting[0]) {
                        _send(waiting[0].sender, { gotLock: lockName, id: waiting[0].id })
                    }
                }
            }
        }
    })
    _tickOn()
} else {
    process.on('message', _handle_message)
}

exports.root = new Proxy(rawRoot, observer)

exports.lockAutoRelease = function(target, callback) {
    _lock(target, callback, true)
}

exports.lockAsyncRelease = function (target, callback) {
    _lock(target, callback, false)
}