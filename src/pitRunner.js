const fs = require('fs-extra')
const url = require('url')
const path = require('path')
const axios = require('axios')
const assign = require('assign-deep')
const Parallel = require('async-parallel')

const lxd = require('./utils/lxd.js')
const log = require('./utils/logger.js')
const { to } = require('./utils/async.js')
const { runScript } = require('./utils/scripts.js')
const { envToScript } = require('./utils/scripts.js')
const clusterEvents = require('./utils/clusterEvents.js')
const Pit = require('./models/Pit-model.js')
const Node = require('./models/Node-model.js')
const config = require('./config.js')

const snakepitPrefix = 'sp'
const containerNameParser = /sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/
const utilParser = /[^,]+, ([0-9]+), ([0-9]+) \%, ([0-9]+) \%/

const headNode = Node.build({
    id: 'head',
    endpoint: config.endpoint
})

let currentContainers = {}
async function getContainerNode (pitId, instance) {
    let pitContainers = currentContainers[pitId]
    let nodeId = pitContainers && pitContainers.find(c => c[2] == instance)
    return nodeId && nodeId[0] && await getNodeById(nodeId[0])
}

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
    return getContainerName(nodeId, pitId, index) + '.' + config.lxdDomain
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
    let containers = []
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
        timeout:  config.containerTimeout,
        force:    !!force,
        stateful: !!stateful
    })
}

async function sendToContainer (containerName, filePath, content, options) {
    let node = await getNodeFromName(containerName)
    await lxd.post(node.endpoint, 'containers/' + containerName + '/files?path=' + filePath, content, assign({
        headers: {
            'Content-Type': 'plain/text',
            'X-LXD-type':   'file'
        }
    }, options || {}))
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

function generateKeyPair () {
    return new Promise((resolve, reject) => {
        runScript('keygen.sh', {}, async (code, stdout, stderr) => {
            if (code) {
                reject(code)
                return
            }
            let lines = stdout.split('\n')
            let splitter = lines.indexOf('-----BEGIN SSH-RSA PUBLIC KEY-----')
            if (splitter <= 0 || splitter >= lines.length - 1) {
                reject(2)
                return
            }
            // worker nodes can't connect to daemon node because ssh key is in
            // invalid format on worker. needs newline.
            resolve([
                lines.slice(0, splitter).join('\n').trim() + '\n',
                lines.slice(splitter + 1).join('\n').trim() + '\n'
            ])
        })
    })
}

async function startPit (pitId, drives, workers) {
    try {
        clusterEvents.emit('pitStarting', pitId)

        let [key, keyPub] = await generateKeyPair()

        let pitDir = Pit.getDir(pitId)
        let daemonHash = (await lxd.get(headNode.endpoint, 'images/aliases/snakepit-daemon')).target
        let workerHash = (await lxd.get(headNode.endpoint, 'images/aliases/snakepit-worker')).target

        let daemonDevices = {
            'pit': {
                path: '/data/rw/pit',
                source: Pit.getDirExternal(pitId),
                type: 'disk'
            },
            'eth0': {
                type:    'nic',
                nictype: 'bridged',
                parent:  config.lxdBridge
            }
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
        await setContainerState(daemonContainerName, 'start')
        await sendToContainer(
            daemonContainerName,
            '/home/worker/.ssh/authorized_keys',
            keyPub,
            { headers: {
                'X-LXD-mode': '0644',
                'X-LXD-gid':  '2525',
                'X-LXD-uid':  '2525'
            } }
        )

        await Parallel.each(workers, async function createWorker(worker) {
            let index = workers.indexOf(worker)
            let containerName = getContainerName(worker.node.id, pitId, index)
            let workerDir = path.join(pitDir, 'workers', '' + index)
            await fs.mkdirp(workerDir)
            await addContainer(
                containerName,
                workerHash,
                assign({
                    devices: {
                        'eth0': {
                            type:    'nic',
                            nictype: 'bridged',
                            parent:  config.lxdBridge
                        }
                    }
                }, worker.options || {})
            )
        })

        let daemonFQDN = daemonContainerName + '.' + config.lxdDomain
        await Parallel.each(workers, async worker => {
            let workerIndex = workers.indexOf(worker)
            let containerName = getContainerName(worker.node.id, pitId, workerIndex)
            await setContainerState(containerName, 'start')
            await sendToContainer(
                containerName,
                '/root/.ssh/id_rsa',
                key,
                { headers: {
                    'X-LXD-mode': '0600'
                } }
            )
            await sendToContainer(
                containerName,
                '/root/.ssh/id_rsa.pub',
                keyPub,
                { headers: {
                    'X-LXD-mode': '0644'
                } }
            )
            await sendToContainer(containerName, '/env.sh', envToScript(assign({
                DAEMON:       daemonFQDN,
                WORKER_INDEX: workerIndex
            }, worker.env), true))
        })
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
        let stopListener = (stoppingPitId) => {
            if (stoppingPitId == pitId) {
                if (timer) {
                    clearTimeout(timer)
                }
                clusterEvents.removeListener('pitStopped', stopListener)
                resolve()
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
    await waitForPit(pitId, timeout)
}
exports.runPit = runPit

async function exec (pitId, instance, context) {
    let node = await getContainerNode(pitId, instance)
    if (!node) {
        return
    }
    let containerName = getContainerName(node.id, pitId, instance)
    return await lxd.post(
        node.endpoint,
        'containers/' + containerName + '/exec',
        assign({
            'interactive': true,
            'wait-for-websocket': true,
        }, context),
        { openSocket: true }
    )
}
exports.exec = exec

function getLogPath (pitId) {
    return path.join(Pit.getDir(pitId), 'pit.log')
}
exports.getLogPath = getLogPath

async function getLog (pitId) {
    try {
        return await fs.readFile(getLogPath(pitId))
    } catch (ex) {
        return undefined
    }
}
exports.getLog = getLog

async function getResults (pitId) {
    let pitDir = Pit.getDir(pitId)
    let workersDir = path.join(pitDir, 'workers')
    let workers = await fs.readdir(workersDir)
    workers = workers.map(w => parseInt(w)).filter(w => !isNaN(w)).sort((a, b) => a - b)
    let results = []
    await Parallel.each(workers, async worker => {
        let result = {}
        let [errStatus, statusContent] = await to(fs.readFile(path.join(workersDir, worker + '', 'status')))
        if (statusContent) {
            result.status = Number(statusContent.toString())
        }
        let [errResult, resultContent] = await to(fs.readFile(path.join(workersDir, worker + '', 'result')))
        if (resultContent) {
            result.result = resultContent.toString()
        }
        results[worker] = result
    })
    return results
}
exports.getResults = getResults

async function stopPit (pitId) {
    log.debug('Stopping pit', pitId)
    clusterEvents.emit('pitStopping', pitId)
    await to(fs.ensureFile(path.join(Pit.getDir(pitId), 'stop')))
}
exports.stopPit = stopPit

async function stopContainers (pitId) {
    let nodes = await getAllNodes()
    await Parallel.each(nodes, async node => {
        let [errC, containers] = await to(getContainersOnNode(node))
        if (containers) {
            await Parallel.each(containers, async containerName => {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo && containerInfo[1] == pitId) {
                    let [errStop] = await to(setContainerState(containerName, 'stop', true))
                    let [errDelete] = await to(lxd.delete(node.endpoint, 'containers/' + containerName))
                }
            })
        }
    })
    clusterEvents.emit('pitStopped', pitId)
}

async function tick () {
    let containers = {}
    let nodes = await getAllNodes()
    await to(Parallel.each(nodes, async node => {
        let [err, nodeContainers] = await to(getContainersOnNode(node))
        let online = !!nodeContainers
        if (node == headNode) {
            if (err) {
                log.error('Problem accessing head node', err.toString())
            }
        } else {
            if (online != node.online) {
                if (err) {
                    log.error('Problem accessing node ' + node.id, err.toString())
                }
                node.online = online
                node.since = Date.now()
                await node.save()
            }
            if (online) {
                let murl = url.parse(node.endpoint)
                let durl = 'http://' + murl.hostname + ':' + (parseInt(murl.port || 80) + 1)
                try {
                    let utilizations = []
                    for (let data of (await axios.get(durl)).data.split('\n')) {
                        if (data = utilParser.exec(data)) {
                            utilizations.push(data)
                        }
                    }
                    if (utilizations.length > 0) {
                        let resources = await node.getResources()
                        for (let i = 0; i < utilizations.length; i++) {
                            let resource = resources.find(r => r.index == i)
                            if (resource) {
                                await resource.addUtilization(
                                    parseFloat(utilizations[i][2]) / 100.0,
                                    parseFloat(utilizations[i][3]) / 100.0
                                )
                            }
                        }
                    }
                } catch (ex) {}
            }
        }
        if (!err && nodeContainers) {
            for (let containerName of nodeContainers) {
                let containerInfo = parseContainerName(containerName)
                if (containerInfo) {
                    let pitId = containerInfo[1]
                    let pitContainers = containers[pitId]
                    if (!pitContainers) {
                        pitContainers = containers[pitId] = []
                    }
                    pitContainers.push(containerInfo)
                }
            }
        }
    }))
    clusterEvents.emit('containerReport', containers)
    let pits = Object.keys(containers)
    clusterEvents.emit('pitReport', pits)
    await Parallel.each(pits, async pitId => {
        if (!(await Pit.findByPk(pitId)) || (await pitRequestedStop(pitId))) {
            log.debug('Stopping zombie containers of pit', pitId)
            await stopContainers(pitId)
        }
    })
}

clusterEvents.on('containerReport', containers => currentContainers = containers)

function loop () {
    let goon = () => setTimeout(loop, config.pollInterval)
    tick().then(goon).catch(goon)
}

exports.startup = async function () {
    loop()
}
