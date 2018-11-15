const dns = require('dns')
const url = require('url')
const util = require('util')
const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const config = require('./config.js')
const { headNode, getNodeById, getAllNodes } = require('./nodes.js')

const snakepitPrefix = 'sp'
const containerNameParser = /sp([0-9]+)-(0|[1-9][0-9]*)/g;

var agent = new https.Agent({ 
    key: config.lxdKey, 
    cert: config.lxdCert,
    rejectUnauthorized: false
})

var headInfo
var exports = module.exports = {}

function to (promise) {
    return promise.then(data => [null, data]).catch(err => [err])
}

async function wrapLxdResponse (node, promise) {
    let [err, response] = await to(promise)
    if (err) {
        console.log(err)
        throw err.message
    }
    let data = response.data
    switch(data.type) {
        case 'sync':
            if (data.metadata && data.metadata.err) {
                throw data.metadata.err
            }
            return data.metadata
        case 'async':
            console.log('Forwarding:', data.operation + '/wait')
            return await wrapLxdResponse(node, axios.get(node.lxdEndpoint + data.operation + '/wait', { httpsAgent: agent }))
        case 'error':
            throw data.error
    }
}

function callLxd(method, node, resource, data) {
    let axiosConfig = {
        method: method,
        url: getUrl(node, resource),
        httpsAgent: agent,
        data: data
    }
    //console.log(method, axiosConfig.url, data)
    return wrapLxdResponse(node, axios(axiosConfig))
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

function getContainerName (pitId, instance) {
    return snakepitPrefix + pitId + '-' + instance
}

function parseContainerName (containerName) {
    let match = containerNameParser.exec(containerName)
    return match && [match[1], match[2]]
}

async function getHeadInfo () {
    if (headInfo) {
        return headInfo
    }
    return headInfo = await lxdGet(headNode, '')
}
exports.getHeadInfo = getHeadInfo

async function testAsync () {
    return await getHeadInfo()
}

exports.test = function () {
    testAsync()
    .then(result => console.log(result))
    .catch(err => console.log(err))
}

async function getHeadCertificate () {
    let info = await getHeadInfo()
    return info.environment && info.environment.certificate
}

function getUrl (node, resource) {
    return node.lxdEndpoint + '/1.0' + (resource ? ('/' + resource) : '')
}

async function getContainersOnNode (node) {
    let results = await to(lxdGet(node, 'containers'))
    return results.filter(result => parseContainerName(result))
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
            server:      config.lxdEndpoint,
            protocol:    'lxd',
            certificate: cert,
            alias:       image
        },
    }, options || {})
    //console.log(containerConfig)
    return await lxdPost(node, 'containers', containerConfig)
}

async function setContainerState (node, containerName, state, force, stateful) {
    await lxdPut(node, 'containers/' + containerName + '/state', {
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
        network = snakepitPrefix + pitId
        await Parallel.each(endpoints, async function (localEndpoint) {
            let tunnelConfig = {}
            for (let remoteEndpoint of endpoints) {
                if (localEndpoint !== remoteEndpoint) {
                    let tunnel = 'tunnel.' + physicalNodes[remoteEndpoint].id
                    tunnelConfig[tunnel + '.protocol'] = 'vxlan',
                    tunnelConfig[tunnel + '.id'] = pitId
                }
            }
            await lxdPost(physicalNodes[localEndpoint], 'networks', {
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
    let daemonContainerName = getContainerName(pitId, 0)
    await addContainer(headNode, 'snakepit-daemon', daemonContainerName, { devices: daemonDevices })

    await Parallel.each(workers, async function (worker) {
        let containerName = getContainerName(pitId, workers.indexOf(worker) + 1)
        let workerDevices = {}
        if (network) {
            workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        await addContainer(worker.node, 'snakepit-worker', containerName, { devices: workerDevices })
    })

    await setContainerState(headNode, daemonContainerName, 'start')
    await Parallel.each(workers, async function (worker) {
        let containerName = getContainerName(pitId, workers.indexOf(worker) + 1)
        await setContainerState(worker.node, containerName, 'start')
    })
}
exports.createPit = createPit

async function dropPit (pitId) {
    let nodes = {}
    await Parallel.each(getAllNodes(), async node => {
        let containers = await getContainersOnNode(node)
        for (let containerName of containers) {
            let containerInfo = parseContainerName(containerName)
            if (containerInfo && containerInfo[0] === pitId) {
                nodes[node.id] = true
                await lxdDelete(node, 'containers/' + containerName)
            }
        }
    })
    nodes = Object.keys(nodes)
    if (nodes.length > 1) {
        Parallel.each(nodes, async function (nodeId) {
            await lxdDelete(getNodeById(nodeId), 'networks/' + snakepitPrefix + pitId)
        })
    }
}
exports.dropPit = dropPit 

async function getPits () {
    let err, containers
    [err, containers] = await to(getContainersOnNode(headNode))
    let pitIds = {}
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        if (containerInfo) {
            pitIds[containerInfo[0]] = true
        }
    }
    return Object.keys(pitIds)
}
exports.getPits = getPits