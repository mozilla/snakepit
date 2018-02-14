const fs = require('fs')
const cluster = require('cluster')
const shared = require('./shared.js')

var exports = module.exports = {}

const PARENT_SYMBOL = Symbol('parent')
const NAME_SYMBOL = Symbol('name')
const DB_PATH = process.env.SNAKEPIT_DB || 'db.json'

var rawRoot = (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).isFile()) ? JSON.parse(fs.readFileSync(DB_PATH).toString()) : {}
_parentify(rawRoot, null, '')
var dirty = false

function log(msg) {
    var entity = cluster.worker ? ('Worker ' + cluster.worker.id) : 'Master'
    console.log(entity + ': ' + msg)
}

function _send(msg, skip_worker) {
    log('sending message:' + JSON.stringify(msg))
    if (cluster.isMaster)
        for(var wid in cluster.workers) {
            var worker = cluster.workers[wid]
            if (worker !== skip_worker)
                worker.send(msg)
        }
    else
        process.send(msg)
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
        log('Setting property "' + name + '" of object "' + path + '" to value "' + value_str + '"')
        if (this != 'skip') _send({ store_operation: 'set', path: path, args: [name, value] })
        dirty = true
        return Reflect.set(target, name, value)
    },
    deleteProperty: function(target, name) {
        var path = _getPath(target)
        log('Deleting property "' + name + '" of object "' + path + '"')
        if (this != 'skip') _send({ store_operation: 'deleteProperty', path: path, args: [name] })
        dirty = true
        return Reflect.deleteProperty(...arguments)
    }
}

function _handle_message(msg) {
    log('Got a message ' + JSON.stringify(msg))
    if (msg.store_operation) {
        observer[msg.store_operation].apply('skip', [_getObject(msg.path)].concat(msg.args))
    }
}

function _tickOn() {
    setTimeout(_tick, 1000)
}

function _tick() {
    //console.log('Tick...')
    if (dirty) {
        fs.writeFile(DB_PATH, JSON.stringify(rawRoot, null, '\t'), function(err) {
            if(err)
                return console.err(err);
            console.log('Wrote db!')
            dirty = false
        })
    }
    _tickOn()
}

if (cluster.isMaster) {
    cluster.on('fork', worker => worker.on('message', msg => {
        _handle_message(msg)
        _send(msg, worker)
    }))
    _tickOn()
} else
    process.on('message', _handle_message)

exports.root = new Proxy(rawRoot, observer)