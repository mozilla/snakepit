const fs = require('fs')
const path = require('path')
const stream = require('stream')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const CombinedStream = require('combined-stream')

const store = require('./store.js')
const config = require('./config.js')
const { getScript } = require('./utils.js')
const { getAlias } = require('./aliases.js')

const pollInterval = config.pollInterval || 1000
const reconnectInterval = config.reconnectInterval || 60000

var exports = module.exports = new EventEmitter()

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}

exports.nodeStates = nodeStates


var db = store.root
var observers = {}

function _startScriptOnNode(node, scriptName, env) {
    let script = getScript(scriptName)
    let address = node.user + '@' + node.address
    //console.log('Running script "' + scriptPath + '" on "' + address + '"')
    p = spawn('ssh', [address, '-p', node.port, 'bash -s'])
    var stdinStream = new stream.Readable()
    Object.keys(env).forEach(name => stdinStream.push('export ' + name + '=' + env[name] + '\n'))
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
    p.on('close', code => callback(code, stdout.join('\n'), stderr.join('\n')))
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

function _checkAvailability(node, callback) {
    _runScriptOnNode(node, 'scan.sh', (err, stdout, stderr) => {
        console.log(stdout)
        if (err) {
            console.error(err)
            callback()
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
            callback(resources)
        }
    })
}

function _setNodeState(node, nodeState) {
    node.state = nodeState
    node.since = new Date().toISOString()
    exports.emit('state', node.id, node.state)
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
            var id = req.params.id
            node = req.body
            dbnode = db.nodes[id] || {}
            newnode = {
                id: id,
                address: node.address || dbnode.address,
                port: node.port || dbnode.port || 22,
                user: node.user || dbnode.user || config.user,
                state: nodeStates.ONLINE
            }
            if (newnode.address) {
                _checkAvailability(newnode, resources => {
                    if (resources) {
                        if (node.cvd) {
                            resources = resources.filter(resource =>
                                type != 'cuda' ||
                                node.cvd.includes(resource.index)
                            )
                        }
                        newnode.resources = {}
                        for(let resource of resources) {
                            newnode.resources[resource.type + resource.index] = resource
                        }
                        db.nodes[id] = newnode
                        res.status(200).send()
                    } else {
                        res.status(400).send({ message: 'Node not available' })
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
                port:      node.port,
                user:      node.user,
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
                let p = observers[node.id]
                if (p) {
                    p.kill()
                } else {
                    _setNodeState(node, nodeStates.OFFLINE)
                }
                delete db.nodes[node.id]
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}

function _observeNode(node) {
    let pids = {}
    let utilization = {}
    observers[node.id] = _getLinesFromNode(
        node, 
        'poll.sh', 
        { INTERVAL: Math.ceil(pollInterval / 1000) }, 
        line => {
            if (node.state != nodeStates.ONLINE) {
                _setNodeState(node, nodeStates.ONLINE)
            }
            line = line.trim()
            if (line == 'NEXT') {
                exports.emit('data', node.id, pids, utilization)
                pids = {}
                utilization = {}
            } else {
                if(line.startsWith('pid:')) {
                    pids[Number(line.substr(4))] = true
                } else if (line.startsWith('util:')) {
                    let values = line.substr(5).split(',')
                    utilization[values[0]] = {
                        comp: Number(values[1]),
                        mem: Number(values[2])
                    }
                }
            }
        },
        (code, err) => {
            console.log(code, err)
            delete observers[node.id]
            _setNodeState(node, nodeStates.OFFLINE)
        }
    )
}

exports.tick = function() {
    for (let node of Object.keys(db.nodes).map(k => db.nodes[k])) {
        if (node.since) {
            if (node.state == nodeStates.OFFLINE && !observers[node.id]) {
                let stateTime = new Date(node.since).getTime()
                if (stateTime + reconnectInterval < Date.now()) {
                    _observeNode(node)
                }
            }
        } else {
            _observeNode(node)
        }
    }
    setTimeout(exports.tick, pollInterval)
}