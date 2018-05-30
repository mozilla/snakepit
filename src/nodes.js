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

var exports = module.exports = new EventEmitter()

const nodeStates = {
    UNKNOWN: 0,
    OFFLINE: 1,
    ONLINE:  2
}

exports.nodeStates = nodeStates


var db = store.root

function _runScriptOnNode(node, scriptName, env, callback) {
    if (typeof env == 'function') {
        callback = env
        env = {}
    }
    env = env || {}
    let script = getScript(scriptName)
    let address = node.user + '@' + node.address
    //console.log('Running script "' + scriptPath + '" on "' + address + '"')
    p = spawn('ssh', [address, '-p', node.port, 'bash -s'])
    let stdout = []
    p.stdout.on('data', data => stdout.push(data))
    let stderr = []
    p.stderr.on('data', data => stderr.push(data))
    p.on('close', code => callback(code, stdout.join('\n'), stderr.join('\n')))
    var stdinStream = new stream.Readable()
    Object.keys(env).forEach(name => stdinStream.push('export ' + name + '=' + env[name] + '\n'))
    stdinStream.push(script + '\n')
    stdinStream.push(null)
    stdinStream.pipe(p.stdin)
}

function _checkAvailability(node, callback) {
    _runScriptOnNode(node, 'available.sh', (err, stdout, stderr) => {
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

exports.runScriptOnNode = _runScriptOnNode

exports.initDb = function() {
    if (!db.nodes) {
        db.nodes = {}
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
            var id = req.params.id
            if (db.nodes[id]) {
                delete db.nodes[id]
                res.status(200).send()
            } else {
                res.status(404).send()
            }
        } else {
            res.status(403).send()
        }
    })
}

exports.tick = function() {
    setTimeout(exports.tick, pollInterval)
}