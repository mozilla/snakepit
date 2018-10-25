const stream = require('stream')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')
const { getScript, shellQuote } = require('./utils.js')

const pollInterval = config.pollInterval || 1000
const reconnectInterval = config.reconnectInterval || 60000

var exports = module.exports = new EventEmitter()
var dataRoot = config.dataRoot || '/snakepit'

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}

exports.nodeStates = nodeStates


var db = store.root
var observers = {}
var toRemove = {}

function _startScriptOnNode(node, scriptName, env) {
    let script = getScript(scriptName)
    let address = node.user + '@' + node.address
    //console.log('Running script "' + scriptPath + '" on "' + address + '"')
    p = spawn('ssh', ['-oConnectTimeout=10', '-oStrictHostKeyChecking=no', '-oBatchMode=yes', address, '-p', node.port, 'bash -s'])
    var stdinStream = new stream.Readable()
    Object.keys(env).forEach(name => stdinStream.push('export ' + name + '=' + shellQuote(env[name]) + '\n'))
    stdinStream.push(script + '\n')
    stdinStream.push(null)
    stdinStream.pipe(p.stdin)
    return p
}

function _runScriptOnNode(node, scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    env = env || {}
    let p = _startScriptOnNode(node, scriptName, env)
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
}

function _getLinesFromNode(node, scriptName, env, onLine, onEnd) {
    let p = _startScriptOnNode(node, scriptName, env)
    let lastLine
    p.stdout.on('data', data => {
        let lines = data.toString().split('\n')
        if (lastLine && lines.length > 0) {
            lines[0] = lastLine + lines[0]
        }
        lastLine = lines.splice(-1, 1)[0]
        lines.forEach(onLine)
    })
    let stderr = []
    p.stderr.on('data', data => stderr.push(data))
    p.on('close', code => onEnd(code, stderr.join('\n')))
    return p
}

function _scanNode(node, callback) {
    _runScriptOnNode(node, 'scan.sh', { 
        TEST_URL: config.external + '/hello',
        TEST_CERT: config.cert
    }, (code, stdout, stderr) => {
        if (code > 0) {
            callback(code, stderr)
        } else {
            var resources = []
            var types = {}
            stdout.split('\n').forEach(line => {
                let [type, name] = line.split(':')
                if (type && name) {
                    types[type] = (type in types) ? types[type] + 1 : 0
                    resources.push({ type: type, index: types[type], name: name })
                }
            })
            callback(code, resources)
        }
    })
}

function _setNodeState(node, nodeState) {
    node.state = nodeState
    node.since = new Date().toISOString()
    exports.emit('state', node.id, node.state)
    if (toRemove[node.id] && node.state == nodeStates.OFFLINE) {
        setTimeout(() => {
            delete toRemove[node.id]
            delete db.nodes[node.id]
        }, 1000)
    }
}

exports.runScriptOnNode = _runScriptOnNode

exports.initDb = function() {
    if (!db.nodes) {
        db.nodes = {}
    }
    for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
        node.state = nodeStates.OFFLINE
        if (node.since) {
            delete node.since
        }
    }
}

exports.initApp = function(app) {
    app.put('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            let id = req.params.id
            let node = req.body
            let dbnode = db.nodes[id] || {}
            let newnode = {
                id: id,
                address: node.address || dbnode.address,
                state: nodeStates.ONLINE
            }
            if (newnode.address) {
                _scanNode(newnode, (code, result) => {
                    if (code > 0) {
                        res.status(400).send({ message: 'Node not available:\n' + result })
                    } else {
                        newnode.resources = {}
                        for(let resource of result) {
                            if (!node.cvd || resource.type != 'cuda' || node.cvd.includes(resource.index)) {
                                newnode.resources[resource.type + resource.index] = resource
                            }
                        }
                        db.nodes[id] = newnode
                        res.status(200).send()
                    }
                })
            } else {
                res.status(400).send()
            }
        } else {
            res.status(403).send()
        }
    })

    app.get('/nodes', function(req, res) {
        res.status(200).send(Object.keys(db.nodes))
    })

    app.get('/nodes/:id', function(req, res) {
        var node = db.nodes[req.params.id]
        if (node) {
            res.status(200).json({
                id:        node.id,
                address:   node.address,
                state:     node.state,
                since:     node.since,
                resources: Object.keys(node.resources).map(resourceId => {
                    let dbResource = node.resources[resourceId]
                    let resource = {
                        type:  dbResource.type,
                        name:  dbResource.name,
                        index: dbResource.index
                    }
                    let alias = getAlias(dbResource.name)
                    if (alias) {
                        resource.alias = alias
                    }
                    if (dbResource.groups) {
                        resource.groups = dbResource.groups
                    }
                    return resource
                })
            })
        } else {
            res.status(404).send()
        }
    })

    app.delete('/nodes/:id', function(req, res) {
        if (req.user.admin) {
            let node = db.nodes[req.params.id]
            if (node) {
                toRemove[node.id] = true
                let p = observers[node.id]
                if (p) {
                    p.kill()
                } else {
                    _setNodeState(node, nodeStates.OFFLINE)
                }
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}

function _checkNodeObservation(node) {
    //TODO: Check, if observer container is up and running
    //TODO: If not: Instantiate it
}

exports.tick = function() {
    for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
        _checkNodeObservation(node)
    }
    setTimeout(exports.tick, pollInterval)
}