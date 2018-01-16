const shared = require('shared')
const config = require('config')
const cluster = require('cluster')

var exports = module.exports = {}

const parentSymbol = Symbol('parent')
const nameSymbol = Symbol('name')

function _getPath(obj) {
    if(!obj) return null
    var parent = obj[parentSymbol]
    var name = obj[nameSymbol]
    var path = _getPath(parent)
    return path ? (path + '.' + name) : name
}

function _parentify(obj, parent, name) {
    obj[parentSymbol] = parent
    obj[nameSymbol] = name
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
        return (typeof(value) === 'object' && value !== null) ? new Proxy(value, obs) : value
    },
    set: function(target, name, value) {
        var path = _getPath(target) + '.' + name
        if(typeof(value) === 'object' && value !== null) {
            value = JSON.parse(JSON.stringify(value))
            _parentify(value, target, name)
            console.log('Setting object on property ' + path)
        } else
            console.log('Setting value on property ' + path)
        return Reflect.set(target, name, value)
    },
    deleteProperty: function(target, name) {
        var path = _getPath(target) + '.' + name
        console.log('Deleting property ' + path)
        return Reflect.deleteProperty(...arguments)
    }
}

var rawRoot = { [nameSymbol]: '$' }
var root = new Proxy(rawRoot, obs)
var workers = []

exports.registerWorker = function(worker) {
    if(cluster.isMaster)
        workers.push(worker)
    worker.on('message', function(msg) {
        if (msg.store) {
            exports[msg.store.function].apply(null, msg.store.args)
            workers.forEach(w => { if(w !== worker) w.send(msg) })
        }
    })
}