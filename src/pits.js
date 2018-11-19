const https = require('https')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const utils = require('./utils.js')
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

function callLxd(method, node, resource, data, options) {
    let axiosConfig = assign({
        method: method,
        url: getUrl(node, resource),
        httpsAgent: agent,
        data: data
    }, options || {})
    //console.log(method, axiosConfig, data)
    return wrapLxdResponse(node, axios(axiosConfig))
}

function lxdGet (node, resource, options) {
    return callLxd('get', node, resource, undefined, options)
}

function lxdDelete (node, resource, options) {
    return callLxd('delete', node, resource, undefined, options)
}

function lxdPut (node, resource, data, options) {
    return callLxd('put', node, resource, data, options)
}

function lxdPost (node, resource, data, options) {
    return callLxd('post', node, resource, data, options)
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

async function addContainer (node, imageHash, containerName, pitInfo, options) {
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
            fingerprint: imageHash
        },
    }, options || {})
    //console.log(containerConfig)
    await lxdPost(node, 'containers', containerConfig)
    if (pitInfo) {
        let vars = []
        for (let name of Object.keys(pitInfo)) {
            vars.push(name + '=' + utils.shellQuote(pitInfo[name]) + '\n')
        }
        console.log(await lxdPost(
            node, 
            'containers/' + containerName + '/files?path=/etc/pit_info', 
            vars.join(''), 
            {
                headers: { 
                    'Content-Type': 'application/octet-stream',
                    'X-LXD-type':  'file', 
                    'X-LXD-write': 'overwrite'
                } 
            }
        ))
        console.log(await lxdGet(
            node, 
            'containers/' + containerName + '/files?path=/etc/pit_info'
        ))
    }
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
    let daemonHash = (await lxdGet(headNode, 'images/aliases/snakepit-daemon')).target
    let workerHash = (await lxdGet(headNode, 'images/aliases/snakepit-worker')).target

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
    let pitInfo = {
        PIT_ID:             pitId,
        PIT_DAEMON_HOST:    daemonContainerName + '.lxd',
        PIT_WORKER_NUMBER:  workers.length,
        PIT_WORKER_PREFIX:  snakepitPrefix + pitId + '-',
        PIT_WORKER_POSTFIX: '.lxd'
    }

    await addContainer(headNode, daemonHash, daemonContainerName, pitInfo, { devices: daemonDevices })

    await Parallel.each(workers, async function (worker) {
        let containerName = getContainerName(pitId, workers.indexOf(worker) + 1)
        let workerDevices = {}
        if (network) {
            workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        await addContainer(worker.node, workerHash, containerName, pitInfo, { devices: workerDevices })
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