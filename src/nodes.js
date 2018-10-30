const https = require('https')
const axios = require('axios')
const { EventEmitter } = require('events')

const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')

const agent = new https.Agent({ 
    key: config.lxdkey, 
    cert: config.lxdcert,
    rejectUnauthorized: false
})
const stdOptions = { httpsAgent: agent }
const headNode = { id: 'head', address: config.lxd }
const nodeStates = {
    OFFLINE: 0,
    ONLINE:  1
}

exports.nodeStates = nodeStates

var db = store.root
var observers = {}
var toRemove = {}
var headInfo
var exports = module.exports = new EventEmitter()


function getHeadCertificate() {
    if (!headInfo) {
        let response = await axios.get(getUrl(), stdOptions)
        if (response) {
            headInfo = response.metadata
        }
    }
    return headInfo && headInfo.environment && headInfo.environment.certificate
}

function getUrl(node, resource) {
    if (!resource) {
        resource = node
        baseUrl = config.lxd
    } else {
        baseUrl = node.address
    }
    return baseUrl + '/1.0' + (resource ? ('/' + resource) : '')
}

function interpretResult(promise) {
    return promise.then(data => {
        return data.type == 'error' ? [data.error] : [null, data]
    }).catch(err => [err])
}

function lxdGet(node, resource) {
    return interpretResult(axios.get(getUrl(node, resource), stdOptions))
}

function lxdDelete(node, resource) {
    return interpretResult(axios.delete(getUrl(node, resource), stdOptions))
}

function lxdPut(node, resource, data) {
    return interpretResult(axios.put(getUrl(node, resource), data, stdOptions))
}

function lxdPost(node, resource, data) {
    return interpretResult(axios.post(getUrl(node, resource), data, stdOptions))
}

function getSnakeId(pitId, node, name) {
    return pitId + '-' + node.id + '-' + name
}

function parseSnakeId(sId) {
    let res = /sp-pit-[a-z0-9]+-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)/.exec(sId)
    return { pitId: res[1], nId: res[2], name: res[3] }
}

function getNetworkId(pitId) {
    return pitId + '-network'
}

function getDaemonId(pitId) {
    return pitId + '-snaked'
}

function getAllNodes() {
    nodes = [headNode]
    for (let nId of Object.keys(db.nodes)) {
        nodes.push(db.nodes[nId])
    }
    return nodes
}

function getNodeById(nId) {
    return nId == 'head' ? headNode : db.nodes[nId]
}

function getSnakeUrl(sId) {
    let snakeInfo = parseSnakeId(sId)
    let node = getNodeById(snakeInfo.nId)
    return getUrl(node.address) + '/containers/' + sId
}


async function getPits () {
    let err, snakes
    [err, snakes] = getSnakes(headNode)
    if (snakes) {
        let sIds = {}
        for (let sId of snakes) {
            let snakeInfo = parseSnakeId(sId)
            sIds[snakeInfo.sId] = true
        }
        return Object.keys(sIds)
    }
    return []
}
exports.getPits = getPits


async function createPit (name, drives) {
    let pitId = 'sp-pit-' + name
    await axios.put(getUrl('networks/' + getNetworkId(pitId)), {
        "config": {
            "bridge.driver": "vxnet",
            "ipv4.address": "10.0.0.1/24"
        }
    }, stdOptions)
    let devices = {}
    if (drives) {
        for (let dest of Object.keys(drives)) {
            driveOptions[dest] = {
                path: '/' + dest,
                source: drives[dest],
                type: 'disk'
            }
        }
    }
    await addSnake(pitId, headNode, 'snaked', getDaemonId(pitId), { devices: devices })
    return pitId
}
exports.createPit = createPit


async function dropPit (pitId) {
    for(let node of getAllNodes()) {
        for (let sId of getSnakes(node)) {
            if (sId.startsWith(pitId)) {
                removeSnake(sId)
            }
        }
    }
    await axios.delete(config.lxd + '/networks/' + getNetworkId(pitId), stdOptions)
}
exports.dropPit = dropPit


async function getSnakes (node) {
    let address = node ? node.address : config.lxd 
    let result = await axios.get(address + '/containers', stdOptions)
    return result.data
}
exports.getContainers = getContainers

 
async function addSnake (pitId, node, image, name, options) {
    let sId = getSnakeId(pitId, node, name)
    let config = Object.assign({
        name: sId,
        architecture: 'x86_64',
        profiles: [],
        ephemeral: false,
        devices: {
            'kvm': {
                path: '/dev/kvm',
                type: 'unix-char'
            },
            'eth0': {
                name:    'eth0',
                nictype: 'bridged',
                parent:  getNetworkId(pitId),
                type:    'nic'
            }
        },
        source: {
            type:        'image',
            mode:        'pull',
            server:      config.lxd,
            protocol:    'lxd',
            certificate: getHeadCertificate(),
            alias:       image
        },
    }, options)
    await axios.post(getUrl('containers/' + sId), config, stdOptions)
    return sId
}
exports.addSnake = addSnake


async function setSnakeState (sId, state, force, stateful) {
    await axios.put(getSnakeUrl(sId) + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    }, stdOptions)
}
exports.startSnake = startSnake


async function startSnake (sId) {
    await setSnakeState(sId, 'start')
}
exports.startSnake = startSnake


async function stopSnake (sId) {
    await setSnakeState(sId, 'stop')
}
exports.stopSnake = stopSnake


async function exec (sId, command, env) {
    let call = await axios.post(getSnakeUrl(sId) + '/exec', {
        command:              command,
        environment:          env,
        'wait-for-websocket': true,
        interactive:          false
    }, stdOptions)
    if (call && call.metadata && call.metadata.fds) {

    }
}
exports.execSync = execSync


async function removeSnake (sId) {
    await axios.delete(getSnakeUrl(sId), stdOptions)
}
exports.removeSnake = removeSnake


async function _scanNode(node) {
    let pitId = await createPit('test' + node.id, { 'snakepit': config.dataRoot })
    let sId = await addSnake(pitId, node, 'snakew', 'scanner')
    let output = await exec(sId, "bash -c 'ls -la /data; nvidia-smi'")
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
