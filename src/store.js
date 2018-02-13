const shared = require('./shared.js')
const cluster = require('cluster')

var exports = module.exports = {}

const parentSymbol = Symbol('parent')
const nameSymbol = Symbol('name')

var rawRoot = { [nameSymbol]: '$' }
var workers = []

function _send(msg) {
    console.log('sending message:' + JSON.stringify(msg))
    workers.forEach(w => { w.send(msg) })
}

function _getPath(obj) {
    if(!obj) return ''
    var parent = obj[parentSymbol]
    var name = obj[nameSymbol]
    var path = _getPath(parent)
    return path.length > 0 ? (path + '.' + name) : path
}

function _getObject(path) {
    var obj = rawRoot
    path.split('.').forEach(name => { obj = obj[name] })
    return obj
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
        return (typeof(value) === 'object' && value !== null) ? new Proxy(value, observer) : value
    },
    set: function(target, name, value) {
        var path = _getPath(target)
        var value_str = JSON.stringify(value)
        if(typeof(value) === 'object' && value !== null) {
            value = JSON.parse(value_str)
            _parentify(value, target, name)
        } 
        console.log('Setting property "' + name + '" of object "' + path + '" to value "' + value_str + '"')
        _send({ store_operation: 'set', path: path, args: [name, value] })
        return Reflect.set(target, name, value)
    },
    deleteProperty: function(target, name) {
        var path = _getPath(target) + '.' + name
        console.log('Deleting property "' + name + '" of object "' + path + '"')
        _send({ store_operation: 'deleteProperty', path: path, args: [name] })
        return Reflect.deleteProperty(...arguments)
    }
}

exports.registerWorker = function(worker) {
    workers.push(worker)
    worker.on('message', function(msg) {
        console.log('Got a message ' + JSON.stringify(msg))
        if (msg.store_operation) {
            console.log('An operation!')
            observer[msg.store_operation].apply(null, _getObject(msg.path), msg.args)
            workers.forEach(w => { if(w !== worker) w.send(msg) })
        }
    })
}

exports.root = new Proxy(rawRoot, observer)