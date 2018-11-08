const dns = require('dns')
const url = require('url')
const util = require('util')
const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const store = require('./store.js')
const config = require('./config.js')
const nodesModule = require('./nodes.js')

const lookupAsync = util.promisify(dns.lookup)

const snakepitPrefix = 'sp-'
const networkPrefix = snakepitPrefix + 'net-'
const containerPrefix = snakepitPrefix + 'container-'
const workerMark = 'w'
const workerContainerPrefix = containerPrefix + workerMark
const daemonMark = 'd'
const daemonContainerPrefix = containerPrefix + daemonMark

const headNode = nodesModule.headNode
const agent = new https.Agent({ 
    key: config.lxdkey, 
    cert: config.lxdcert,
    rejectUnauthorized: false
})

var db = store.root
var headInfo
var exports = module.exports = {}

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

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
    return node.lxdEndpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function interpretResult (node, response) {
    switch(response.data.type) {
        case 'sync':
            console.log('Result:', response.data.metadata)
            return response.data.metadata
        case 'async':
            console.log('Forwarding:', response.data.operation + '/wait')
            let wres = await axios.get(node.lxdEndpoint + response.data.operation + '/wait', stdOptions)
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

async function wrapPromise (node, promise) {
    return promise.then(response => interpretResult(node, response))
}

function callLxd(method, node, resource, data) {
    let u = getUrl(node, resource)
    let axiosConfig = {
        method: method,
        url: u,
        httpsAgent: agent,
        data: data
    }
    console.log(method, u, data)
    return wrapPromise(node, axios(axiosConfig))
}

function lxdGet (node, resource) {
    return callLxd('get', node, resource)
}

function lxdDelete (node, resource) {
    return callLxd('delete', node, resource)
}

function lxdPut (node, resource, data) {
    return callLxd('put', node, resource, data)
}

function lxdPost (node, resource, data) {
    return callLxd('post', node, resource, data)
}

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

async function addContainer (node, image, containerName, options) {
    let cert = await getHeadCertificate()
    let containerConfig = assign({
        name: containerName,
        architecture: 'x86_64',
        profiles: [],
        ephemeral: true,
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

async function setContainerState (containerName, state, force, stateful) {
    let [node, resource] = getContainerNodeAndResource(containerName)
    await lxdPut(node, resource + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

async function createPit (pitId, drives, workers) {
    let physicalNodes = { [headNode.lxdEndpoint]: headNode }
    for (let worker of workers) {
        // we just need one virtual node representant of/on each physical node
        physicalNodes[worker.node.lxdEndpoint] = worker.node
    }
    let network
    let endpoints = Object.keys(physicalNodes)
    if (endpoints.length > 1) {
        network = networkPrefix + pitId
        let addresses = {}
        console.log('Resolving...')
        await Parallel.each(endpoints, async function (endpoint) {
            if (physicalNodes[endpoint].address) {
                addresses[endpoint] = physicalNodes[endpoint].address
            } else {
                let result = await lookupAsync(url.parse(endpoint).hostname)
                addresses[endpoint] = result.address
            }
        })
        console.log('Resolving done.')
        await Parallel.each(endpoints, async function (localEndpoint) {
            let localNode = physicalNodes[localEndpoint]
            let localAddress = addresses[localEndpoint]
            let tunnelConfig = {}
            for (let remoteEndpoint of endpoints) {
                if (localEndpoint !== remoteEndpoint) {
                    let remoteNode = physicalNodes[remoteEndpoint]
                    let remoteAddress = addresses[remoteEndpoint]
                    let tunnel = 'tunnel.' + remoteNode.id
                    tunnelConfig[tunnel + '.protocol'] = 'gre',
                    tunnelConfig[tunnel + '.local']    = localAddress,
                    tunnelConfig[tunnel + '.remote']   = remoteAddress
                }
            }
            await lxdPost(localNode, 'networks', {
                name: network,
                config: tunnelConfig
            })
        })
    }

    let daemonDevices = {}
    if (network) {
        daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
    }
    if (drives) {
        for (let dest of Object.keys(drives)) {
            daemonDevices[dest] = {
                path: '/' + dest,
                source: drives[dest],
                type: 'disk'
            }
        }
    }
    let daemonContainerName = getDaemonContainerName(pitId)
    await addContainer(headNode, 'snakepit-daemon', daemonContainerName, { devices: daemonDevices })

    await Parallel.each(workers, async function (worker) {
        let containerName = getWorkerContainerName(pitId, worker.node, workers.indexOf(worker))
        let workerDevices = {}
        if (network) {
            workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        await addContainer(node, 'snakepit-worker', containerName, { devices: workerDevices })
    })

    await setContainerState(daemonContainerName, 'start')
    await Parallel.each(workers, async function (worker) {
        let containerName = getWorkerContainerName(pitId, worker.node, workers.indexOf(worker))
        await setContainerState(containerName, 'start')
    })
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
        Parallel.each(Object.keys(nodes), async function (nodeId) {
            await lxdDelete(getNodeById(nodeId), 'networks/' + networkPrefix + pitId)
        })
    }
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

exports.createPit = createPit
exports.dropPit = dropPit
exports.getPits = getPits
