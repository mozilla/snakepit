const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
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
    let cert = headInfo && headInfo.environment && headInfo.environment.certificate
    return cert
}

function getUrl (node, resource) {
    return node.address + '/1.0' + (resource ? ('/' + resource) : '')
}

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

async function _interpretResult (node, response) {
    switch(response.data.type) {
        case 'sync':
            console.log('Result:', response.data.metadata)
            return response.data.metadata
        case 'async':
            console.log('Forwarding:', response.data.operation + '/wait')
            let wres = await axios.get(node.address + response.data.operation + '/wait', stdOptions)
            console.log('Result:', wres.data)
            if (wres.err) {
                throw wres.err
            }
            return wres
        case 'error':
            console.log('Error:', response.data.error)
            throw response.data.error
    }
}

async function interpretResult (node, promise) {
    return promise.then(response => _interpretResult(node, response))
}

function lxdGet (node, resource) {
    let u = getUrl(node, resource)
    console.log('GET:', u)
    return interpretResult(node, axios.get(u, stdOptions))
}

function lxdDelete (node, resource) {
    let u = getUrl(node, resource)
    console.log('DELETE:', u)
    return interpretResult(node, axios.delete(u, stdOptions))
}

function lxdPut (node, resource, data) {
    let u = getUrl(node, resource)
    console.log('PUT:', u)
    return interpretResult(node, axios.put(u, data, stdOptions))
}

function lxdPost (node, resource, data) {
    let u = getUrl(node, resource)
    console.log('POST:', u)
    return interpretResult(node, axios.post(u, data, stdOptions))
}

const snakepitPrefix = 'sp-'
const networkPrefix = snakepitPrefix + 'net-'
const containerPrefix = snakepitPrefix + 'container-'
const workerMark = 'w'
const workerContainerPrefix = containerPrefix + workerMark
const daemonMark = 'd'
const daemonContainerPrefix = containerPrefix + daemonMark

function getWorkerContainerName (pitId, node, id) {
    return [workerContainerPrefix, node.id, pitId, id].join('-')
}

function getDaemonContainerName (pitId) {
    return [daemonContainerPrefix, headNode.id, pitId].join('-')
}

function parseContainerName (containerName) {
    if (!containerName.startsWith(containerPrefix)) {
        return
    }
    let str = containerName.slice(containerPrefix.length)
    let isWorker
    if (str.startsWith(workerMark)) {
        isWorker = true
        containerName = containerName.slice(workerMark.length + 1)
    } else if (str.startsWith(daemonMark)) {
        isWorker = false
        containerName = containerName.slice(daemonMark.length + 1)
    } else {
        return 
    }
    let parts = containerName.split('-')
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

function getContainerNodeAndResource (containerName) {
    let containerInfo = parseContainerName(containerName)
    let node = getNodeById(containerInfo.nodeId)
    return [node, 'containers/' + containerName]
}

async function getContainersOnNode (node) {
    let results = await to(lxdGet(node, 'containers'))
    return results.filter(result => parseContainerName(result))
}

async function getContainers () {
    let allContainers = []
    await Parallel.each(getAllNodes(), async node => {
        let [err, containers] = await to(getContainersOnNode(node))
        if (!err && containers) {
            allContainers.push(...containers)
        }
    })
    return allContainers
}

async function getPitNodes (pitId) {
    let nodes = {}
    let containers = await getContainers()
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        nodes[containerInfo.nodeId] = true
    }
    return Object.keys(nodes)
}

async function addContainer (pitId, node, image, containerName, options) {
    let cert = await getHeadCertificate()
    let containerConfig = assign({
        name: containerName,
        architecture: 'x86_64',
        profiles: [],
        ephemeral: false,
        devices: {
            'root': {
				path: '/',
				pool: 'default',
				type: 'disk'
			}
        },
        source: {
            type:        'image',
            mode:        'pull',
            server:      config.lxd,
            protocol:    'lxd',
            certificate: cert,
            alias:       image
        },
    }, options || {})
    console.log(containerConfig)
    return await lxdPost(node, 'containers', containerConfig)
}

function addDaemonContainer (pitId, options) {
    return addContainer(pitId, headNode, 'snakepit-daemon', getDaemonContainerName(pitId), options)
}

async function addWorkerContainer (pitId, node, id, options) {
    let netResource = 'networks/' + getNetworkName(pitId),
        err
    [err] = await to(lxdPut(headNode, netResource, {
        "config": {
            "bridge.driver": "vxnet",
            "ipv4.address": "10.0.0.1/24"
        }
    }))
    return addContainer(pitId, node, 'snakepit-worker', getWorkerContainerName(pitId, node, id), options)
}

async function setContainerState (containerName, state, force, stateful) {
    let [node, resource] = getContainerNodeAndResource(containerName)
    await lxdPut(node, resource + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

async function startContainer (containerName) {
    await setContainerState(containerName, 'start')
}

async function stopContainer (containerName) {
    await setContainerState(containerName, 'stop')
}

async function dropContainer (containerName) { 
    await lxdDelete(...getContainerNodeAndResource(containerName))
}

async function createPit (pitId, workers, drives) {
    /*
    TODO: build network on nodes like this:

    # on host 1
    sudo lxc network create <NW1> tunnel.<T1>.protocol=gre tunnel.<T1>.local=<IP1> tunnel.<T1>.remote=<IP2>
    sudo lxc profile create <PRO1>
    sudo lxc profile device remove default eth0
    sudo lxc profile device add <PRO1> root disk path=/ pool=default
    sudo lxc network attach-profile <NW1> <PRO1> eth0 eth0
    sudo lxc init headnode:snakepit-daemon <C1>
    sudo lxc profile assign <C1> <PRO1>

    # on host 2
    sudo lxc network create <NW1> tunnel.<T2>.protocol=gre tunnel.<T2>.local=<IP2> tunnel.<T2>.remote=<IP1>
    sudo lxc profile create <PRO1>
    sudo lxc profile device remove default eth0
    sudo lxc profile device add <PRO1> root disk path=/ pool=default
    sudo lxc network attach-profile <NW1> <PRO1> eth0 eth0
    sudo lxc init headnode:snakepit-daemon <C2>
    sudo lxc profile assign <C2> <PRO1>
    */
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
    return addDaemonContainer(pitId, { devices: devices })
}

async function getPits () {
    let err, containers
    [err, containers] = await to(getContainersOnNode(headNode))
    let pitIds = {}
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        pitIds[containerInfo.pitId] = true
    }
    return Object.keys(pitIds)
}

async function dropPit (pitId) {
    let nodes = {}
    let containers = await getContainers()
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        if (containerInfo.pitId === pitId) {
            nodes[containerInfo.nodeId] = true
            await lxdDelete(getNodeById(nodeId), 'containers/' + containerName)
        }
    }
    if (nodes.length > 1) {
        Parallel.each(Object.keys(nodes), nodeId => {
            await lxdDelete(getNodeById(nodeId), 'networks/' + networkPrefix + pitId)
        })
    }
}

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

exports.createPit = createPit
exports.getPits = getPits
exports.dropPit = dropPit

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
