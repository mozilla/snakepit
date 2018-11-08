const { EventEmitter } = require('events')

const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')

var db = store.root
var observers = {}
var toRemove = {}

var exports = module.exports = new EventEmitter()

const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}
exports.nodeStates = nodeStates

const headNode = { id: 'head', lxdEndpoint: config.lxdEndpoint, address: config.address }
exports.headNode = headNode

async function _scanNode(node) {
    let pitId = await createPit('test' + node.id, { 'snakepit': config.dataRoot })
    let containerName = await addContainer(pitId, node, 'snakepit-worker', 'scanner')
    let output = await exec(containerName, "bash -c 'ls -la /data; nvidia-smi'")
    // TODO: Check output
    return true
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
                lxdEndpoint: node.lxdEndpoint || dbnode.lxdEndpoint,
                address: node.address || dbnode.address,
                state: nodeStates.ONLINE
            }
            if (newnode.lxdEndpoint) {
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
                id:          node.id,
                lxdEndpoint: node.lxdEndpoint,
                address:     node.address,
                state:       node.state,
                since:       node.since,
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
