const fs = require('fs-extra')
const path = require('path')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const lxd = require('./utils/lxd.js')
const log = require('./utils/logger.js')
const { to } = require('./utils/async.js')
const { envToScript } = require('./utils/scripts.js')
const clusterEvents = require('./utils/clusterEvents.js')
const Pit = require('./models/Pit-model.js')
const Node = require('./models/Node-model.js')
const config = require('./config.js')

const snakepitPrefix = 'sp'
const containerNameParser = /sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/

const headNode = Node.build({
    id: 'head',
    endpoint: config.endpoint
})

async function getAllNodes () {
    let nodes = await Node.findAll()
    return [headNode, ...nodes]
}

async function getNodeById (nodeId) {
    return nodeId == 'head' ? headNode : await Node.findByPk(nodeId)
}

function getContainerName (nodeId, pitId, instance) {
    return snakepitPrefix + '-' + nodeId + '-' + pitId + '-' + instance
}

function getDaemonName (pitId) {
    return getContainerName(headNode.id, pitId, 'd')
}

function parseContainerName (containerName) {
    let match = containerNameParser.exec(containerName)
    return match && [match[1], match[2], match[3]]
}

async function getNodeFromName (containerName) {
    let parsed = parseContainerName(containerName)
    return await getNodeById(parsed[0])
}

function getWorkerHost (nodeId, pitId, index) {
    return getContainerName(nodeId, pitId, index) + '.lxd'
}
exports.getWorkerHost = getWorkerHost

function getNodeInfo (node) {
    return lxd.get(node.endpoint, '')
}

var headInfo
async function getHeadInfo () {
    if (headInfo) {
        return headInfo
    }
    return headInfo = await getNodeInfo(headNode)
}

async function getHeadCertificate () {
    let info = await getHeadInfo()
    return info.environment && info.environment.certificate
}

async function getContainersOnNode (node) {
    let results = await lxd.get(node.endpoint, 'containers')
    var containers = []
    for (let result of results) {
        let split = result.split('/')
        if (split.length > 0) {
            let container = split[split.length - 1]
            let containerInfo = parseContainerName(container)
            if (containerInfo && containerInfo[0] == node.id) {
                containers.push(container)
            }
        }
    }
    return containers
}

async function setContainerState (containerName, state, force, stateful) {
    let node = await getNodeFromName(containerName)
    await lxd.put(node.endpoint, 'containers/' + containerName + '/state', {
        action:   state,
        timeout:  config.lxdTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

function pitRequestedStop (pitId) {
    return fs.pathExists(path.join(Pit.getDir(pitId), 'stop'))
}

async function addContainer (containerName, imageHash, options) {
    let node = await getNodeFromName(containerName)
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
            server:      config.endpoint,
            protocol:    'lxd',
            certificate: cert,
            fingerprint: imageHash
        },
    }, options || {})
    await lxd.post(node.endpoint, 'containers', containerConfig)
}

async function startPit (pitId, drives, workers) {
    try {
        clusterEvents.emit('pitStarting', pitId)
        let pitDir = Pit.getDir(pitId)
        let daemonHash = (await lxd.get(headNode.endpoint, 'images/aliases/snakepit-daemon')).target
        let workerHash = (await lxd.get(headNode.endpoint, 'images/aliases/snakepit-worker')).target
        let physicalNodes = { [headNode.endpoint]: headNode }
        for (let worker of workers) {
            // we just need one virtual node representant of/on each physical node
            physicalNodes[worker.node.endpoint] = worker.node
        }
        let network
        let endpoints = Object.keys(physicalNodes)
        network = snakepitPrefix + pitId
        await Parallel.each(endpoints, async function (localEndpoint) {
            let tunnelConfig = {}
            for (let remoteEndpoint of endpoints) {
                if (localEndpoint !== remoteEndpoint) {
                    let tunnel = 'tunnel.' + physicalNodes[remoteEndpoint].id
                    tunnelConfig[tunnel + '.protocol'] = 'vxlan',
                    tunnelConfig[tunnel + '.id'] = '' + pitId
                }
            }
            try {
                await lxd.post(localEndpoint, 'networks', {
                    name: network,
                    config: tunnelConfig
                })
            } catch (ex) {
                log.error('PROBLEM CREATING NETWORK', network, ex.toString())
                throw ex
            }
        })

        let daemonDevices = { 'pit': { path: '/data/rw/pit', source: Pit.getDirExternal(pitId), type: 'disk' } }
        if (network) {
            daemonDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
        }
        if (drives) {
            for (let dest of Object.keys(drives)) {
                daemonDevices[dest] = {
                    path:   dest,
                    source: drives[dest],
                    type:   'disk'
                }
            }
        }
        let daemonContainerName = getDaemonName(pitId)
        await addContainer(
            daemonContainerName, 
            daemonHash, 
            { 
                devices: daemonDevices,
                config: { 'raw.idmap': 'both ' + config.mountUid + ' 2525' }
            }
        )
        await Parallel.each(workers, async function createWorker(worker) {
            let index = workers.indexOf(worker)
            let containerName = getContainerName(worker.node.id, pitId, index)
            let workerDevices = {}
            if (network) {
                workerDevices['eth0'] = { nictype: 'bridged', parent: network, type: 'nic' }
            }
            let workerDir = path.join(pitDir, 'workers', '' + index)
            await fs.mkdirp(workerDir)
            if (worker.env) {
                await fs.writeFile(path.join(workerDir, 'env.sh'), envToScript(worker.env, true))
            }
            if (worker.script) {
                await fs.writeFile(path.join(workerDir, 'script.sh'), worker.script)
            }
            await addContainer(
                containerName, 
                workerHash, 
                assign({ devices: workerDevices }, worker.options || {})
            )
        })

        await Parallel.each(workers, async function (worker) {
            let containerName = getContainerName(worker.node.id, pitId, workers.indexOf(worker))
            await setContainerState(containerName, 'start')
        })
        await setContainerState(daemonContainerName, 'start')
        clusterEvents.emit('pitStarted', pitId)
    } catch (ex) {
        clusterEvents.emit('pitStartFailed', pitId)
        await stopPit(pitId)
        throw ex
    }
}
exports.startPit = startPit

function waitForPit (pitId, timeout) {
    return new Promise((resolve, reject) => {
        let timer
        let stopListener = (stoppingPitId, results) => {
            if (stoppingPitId == pitId) {
                if (timer) {
                    clearTimeout(timer)
                }
                clusterEvents.removeListener('pitStopped', stopListener)
                resolve(results)
            }
        }
        let timeoutListener = () => {
            clusterEvents.removeListener('pitStopped', stopListener)
            reject('timeout')
        }
        clusterEvents.on('pitStopped', stopListener)
        if (timeout) {
            timer = setTimeout(timeoutListener, 1000 * timeout)
        }
    })
}
exports.waitForPit = waitForPit

async function runPit (pitId, drives, workers, timeout) {
    await startPit(pitId, drives, workers)
    return await waitForPit(pitId, timeout)
}
exports.runPit = runPit

async function extractResults (pitId) {
    let pitDir = Pit.getDir(pitId)
    if (await fs.pathExists(pitDir)) {
        let [errLog, pitLog] = await to(fs.readFile(path.join(pitDir, 'pit.log')))
        let workersDir = path.join(pitDir, 'workers')
        let [errWorkers, workers] = await to(fs.readdir(workersDir))
        let [errResults, workerResults] = await to(Parallel.map(workers || [], async worker => {
            let workerDir = path.join(workersDir, worker)
            let [errStatus, statusContent] = await to(fs.readFile(path.join(workerDir, 'status')))
            let status = statusContent ? Number(statusContent.toString()) : 1
            let [errResult, resultContent] = await to(fs.readFile(path.join(workerDir, 'result')))
            let result = resultContent ?        resultContent.toString()  : ''
            return { status: status, result: result }
        }))
        return { log: (pitLog || '').toString(), workers: workerResults || []}
    } else {
        return { log: 'No pit directory', workers: [] }
    }
}

async function stopPit (pitId) {
    log.debug('STOPPING PIT', pitId)
    clusterEvents.emit('pitStopping', pitId)
    let results = await extractResults(pitId) 
    let nodes = await getAllNodes()
    for (let node of nodes) {
        let [err, containers] = await to(getContainersOnNode(node))
        if (containers) {
            for (let containerName of containers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] == pitId) {
                    let [errStop] = await to(setContainerState(containerName, 'stop', true))
                    let [errDelete] = await to(lxd.delete(node.endpoint, 'containers/' + containerName))
                }
            }
        }
    }
    await to(Parallel.each(nodes, async node => {
        await to(lxd.delete(node.endpoint, 'networks/' + snakepitPrefix + pitId))
    }))
    clusterEvents.emit('pitStopped', pitId, results)
}
exports.stopPit = stopPit

async function getActivePits () {
    let [err, containers] = await to(getContainersOnNode(headNode))
    let pitIds = {}
    for (let containerName of containers) {
        let containerInfo = parseContainerName(containerName)
        if (containerInfo) {
            pitIds[containerInfo[1]] = true
        }
    }
    return Object.keys(pitIds)
}
exports.getActivePits = getActivePits

async function tick () {
    let nodes = await getAllNodes()
    await to(Parallel.each(nodes, async node => {
        let [infoErr, info] = await to(getNodeInfo(node))
        if (infoErr) {
            log.error('PROBLEM ACCESSING NODE ' + node.id, infoErr.toString())
        }
        if (node != headNode) {
            node.online = !!info
            await node.save()
        }
    }))
    let [err, pits] = await to(getActivePits())
    //clusterEvents.emit('pitReport', pits)
    await Parallel.each(pits, async pitId => {
        if (await pitRequestedStop(pitId)) {  
            await stopPit(pitId)
        }
    })
}

exports.tick = function () {
    let goon = () => setTimeout(exports.tick, config.pollInterval)
    tick().then(goon).catch(goon)
}
