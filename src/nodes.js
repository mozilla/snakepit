const https = require('https')
const axios = require('axios')
const Parallel = require('async-parallel')
const { EventEmitter } = require('events')

const store = require('./store.js')
const config = require('./config.js')
const { getAlias } = require('./aliases.js')

console.log(config.lxd)

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


async function getHeadCertificate () {
    if (!headInfo) {
        let [err, response] = await to(lxdGet(headNode, ''))
        if (!err && response) {
            headInfo = response
        }
    }
    return headInfo && headInfo.environment && headInfo.environment.certificate
}

function getUrl (node, resource) {
    return node.address + '/1.0' + (resource ? ('/' + resource) : '')
}

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

function interpretResult (promise) {
    return promise.then(data => {
        if (data && data.type == 'error') {
            throw data.error
        } else {
            return data.metadata
        }
    })
}

function lxdGet (node, resource) {
    return interpretResult(axios.get(getUrl(node, resource), stdOptions))
}

function lxdDelete (node, resource) {
    return interpretResult(axios.delete(getUrl(node, resource), stdOptions))
}

function lxdPut (node, resource, data) {
    return interpretResult(axios.put(getUrl(node, resource), data, stdOptions))
}

function lxdPost (node, resource, data) {
    return interpretResult(axios.post(getUrl(node, resource), data, stdOptions))
}

const snakepitPrefix = 'sp-'
const networkPrefix = snakepitPrefix + 'net-'
const snakePrefix = snakepitPrefix + 'snake-'
const workerMark = 'w-'
const workerSnakePrefix = snakePrefix + workerMark
const daemonMark = 'd-'
const daemonSnakePrefix = snakePrefix + daemonMark

function getWorkerSnakeName (pitId, node, id) {
    return [workerSnakePrefix, node.id, pitId, id].join('-')
}

function getDaemonSnakeName (pitId) {
    return [daemonSnakePrefix, headNode.id, pitId].join('-')
}

function parseSnakeName (snakeName) {
    if (!snakeName.startsWith(snakePrefix)) {
        return
    }
    let str = snakeName.slice(snakePrefix.length)
    let isWorker
    if (str.startsWith(workerMark)) {
        isWorker = true
        snakeName = snakeName.slice(workerMark.length)
    } else if (str.startsWith(daemonMark)) {
        isWorker = false
        snakeName = snakeName.slice(daemonMark.length)
    } else {
        return 
    }
    let parts = snakeName.split('-')
    return { 
        worker: isWorker, 
        daemon: !isWorker, 
        nodeId: parts[0], 
        pitId:  parts[1], 
        id:     isWorker ? parts[2] : ''
    }
}

function getAllNodes () {
    nodes = [headNode]
    for (let nodeId of Object.keys(db.nodes)) {
        nodes.push(db.nodes[nodeId])
    }
    return nodes
}

function getNodeById (nodeId) {
    return nodeId == 'head' ? headNode : db.nodes[nodeId]
}

function getSnakeNodeAndResource (snakeName) {
    let snakeInfo = parseSnakeName(snakeName)
    let node = getNodeById(snakeInfo.nodeId)
    return [node, 'containers/' + snakeName]
}

async function getPits () {
    let err, snakes
    [err, snakes] = await to(getSnakesOnNode(headNode))
    let pitIds = {}
    for (let snakeName of snakes) {
        let snakeInfo = parseSnakeName(snakeName)
        pitIds[snakeInfo.pitId] = true
    }
    return Object.keys(pitIds)
}
exports.getPits = getPits

/*
TODO: build network on nodes like this:

# on host 1
sudo lxc network create <NW1> tunnel.<T1>.protocol=gre tunnel.<T1>.local=<IP1> tunnel.<T1>.remote=<IP2>
sudo lxc profile create <PRO1>
sudo lxc profile device remove default eth0
sudo lxc profile device add <PRO1> root disk path=/ pool=default
sudo lxc network attach-profile <NW1> <PRO1> eth0 eth0
sudo lxc init headnode:snaked <C1>
sudo lxc profile assign <C1> <PRO1>

# on host 2
sudo lxc network create <NW1> tunnel.<T2>.protocol=gre tunnel.<T2>.local=<IP2> tunnel.<T2>.remote=<IP1>
sudo lxc profile create <PRO1>
sudo lxc profile device remove default eth0
sudo lxc profile device add <PRO1> root disk path=/ pool=default
sudo lxc network attach-profile <NW1> <PRO1> eth0 eth0
sudo lxc init headnode:snaked <C2>
sudo lxc profile assign <C2> <PRO1>
*/

async function createPit (pitId, drives) {
    let devices = {}
    if (drives) {
        for (let dest of Object.keys(drives)) {
            devices[dest] = {
                path: '/' + dest,
                source: drives[dest],
                type: 'disk'
            }
        }
    }
    return await addDaemonSnake(pitId, { devices: devices })
}
exports.createPit = createPit


async function dropPit (pitId) {
    let [err, snakes] = await to(getSnakes())
    if (!err && snakes) {
        snakes = snakes.filter(snakeName => {
            let snakeInfo = parseSnakeName(snakeName)
            return snakeInfo && snakeInfo.pitId === pitId
        })
        Parallel.each(snakes, async snake => dropSnake(snake))
    }
    await lxdDelete(headNode, 'networks/' + getNetworkName(pitId))
}
exports.dropPit = dropPit


async function getSnakesOnNode (node) {
    let [err, results] = await to(lxdGet(node, '/containers'))
    return results ? results.filter(result => parseSnakeName(result)) : []
}
exports.getSnakesOnNode = getSnakesOnNode


async function getSnakes () {
    let allSnakes = []
    await Parallel.each(getAllNodes(), async node => {
        let [err, snakes] = await to(getSnakesOnNode(node))
        if (!err && snakes) {
            allSnakes.push(...snakes)
        }
    })
    return allSnakes
}
exports.getSnakes = getSnakes

 
async function addSnake (pitId, node, image, snakeName, options) {
    let containerConfig = Object.assign({
        name: snakeName,
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
                parent:  networkPrefix + pitId,
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
    }, options || {})
    return await lxdPost(node, 'containers/' + snakeName, containerConfig)
}

function addDaemonSnake (pitId, options) {
    return addSnake(pitId, headNode, 'snaked', getDaemonSnakeName(pitId), options)
}

async function addWorkerSnake (pitId, node, id, options) {
    let netResource = 'networks/' + getNetworkName(pitId),
        err
    [err] = await to(lxdPut(headNode, netResource, {
        "config": {
            "bridge.driver": "vxnet",
            "ipv4.address": "10.0.0.1/24"
        }
    }))
    return addSnake(pitId, node, 'snakew', getWorkerSnakeName(pitId, node, id), options)
}
exports.addWorkerSnake = addWorkerSnake


async function setSnakeState (snakeName, state, force, stateful) {
    let [node, resource] = getSnakeNodeAndResource(snakeName)
    await lxdPut(node, resource + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}
exports.startSnake = startSnake


async function startSnake (snakeName) {
    await setSnakeState(snakeName, 'start')
}
exports.startSnake = startSnake


async function stopSnake (snakeName) {
    await setSnakeState(snakeName, 'stop')
}
exports.stopSnake = stopSnake


async function exec (snakeName, command, env) {
    let call = await axios.post(getSnakeUrl(snakeName) + '/exec', {
        command:              command,
        environment:          env,
        'wait-for-websocket': true,
        interactive:          false
    }, stdOptions)
    if (call && call.metadata && call.metadata.fds) {

    }
}
exports.exec = exec


async function dropSnake (snakeName) { 
    await lxdDelete(...getSnakeNodeAndResource(snakeName))
}
exports.dropSnake = dropSnake


async function _scanNode(node) {
    let pitId = await createPit('test' + node.id, { 'snakepit': config.dataRoot })
    let snakeName = await addSnake(pitId, node, 'snakew', 'scanner')
    let output = await exec(snakeName, "bash -c 'ls -la /data; nvidia-smi'")
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
