const { MultiRange } = require('multi-integer-range')
const sequelize = require('./models/db.js')
const Node = require('./models/Node-model.js')
const Resource = require('./models/Resource-model.js')
const Alias = require('./models/Alias-model.js')
const Job = require('./models/Job-model.js')
const User = require('./models/User-model.js')
const Group = require('./models/Group-model.js')
const ProcessGroup = require('./models/ProcessGroup-model.js')
const Process = require('./models/Process-model.js')
const Allocation = require('./models/Allocation-model.js')
const Sequelize = require('sequelize')
const parseClusterRequest = require('./clusterParser.js').parse

const log = require('./utils/logger.js')

var exports = module.exports = {}

async function loadNodes (transaction, userId, simulation) {
    let nodes = {}
    let nodeWhere = { available: true }
    
    if (!simulation) {
        nodeWhere.online = true
    }

    let resources = await Resource.findAll({
        include: [
            { 
                model: Node, 
                attributes: [],
                transaction: transaction,
                lock: transaction.LOCK,
                where: nodeWhere
            },
            {
                model: Alias, 
                require: false,
                attributes: ['id'],
                transaction: transaction,
                lock: transaction.LOCK
            },
            { 
                model: Allocation, 
                require: false,
                attributes: [],
                transaction: transaction,
                lock: transaction.LOCK,
                include: [
                    {
                        model: Process,
                        require: false,
                        attributes: [],
                        transaction: transaction,
                        lock: transaction.LOCK,
                        include: [
                            {
                                model: ProcessGroup,
                                require: false,
                                attributes: [],
                                transaction: transaction,
                                lock: transaction.LOCK,
                                include: [
                                    {
                                        model: Job,
                                        require: false,
                                        attributes: [],
                                        transaction: transaction,
                                        lock: transaction.LOCK,
                                        where: { 
                                            state: { 
                                                [Sequelize.Op.gte]: Job.jobStates.STARTING, 
                                                [Sequelize.Op.lte]: Job.jobStates.STOPPING 
                                            } 
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            {
                model: Resource.ResourceGroup,
                require: false,
                attributes: [],
                transaction: transaction,
                lock: transaction.LOCK,
                include: [
                    {
                        model: Group,
                        require: false,
                        attributes: [],
                        transaction: transaction,
                        lock: transaction.LOCK,
                        include: [
                            {
                                model: User.UserGroup,
                                require: false,
                                attributes: [],
                                transaction: transaction,
                                lock: transaction.LOCK,
                                include: [
                                    {
                                        model: User,
                                        require: false,
                                        attributes: [],
                                        transaction: transaction,
                                        lock: transaction.LOCK,
                                        where: { id: userId }
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ],
        group: ['resource.id', 'alias.id'],
        having: [
            sequelize.where(sequelize.fn('count', sequelize.col('allocations->process->processgroup->job.id')), 0),
            sequelize.or(
                sequelize.where(sequelize.fn('count', sequelize.col('resourcegroups->group->usergroups->user.id')), { [Sequelize.Op.gt]: 0 }),
                sequelize.where(sequelize.fn('count', sequelize.col('resourcegroups->group.id')), 0)
            )
        ]
    })
    for (let resource of resources) {
        let nodeResources = nodes[resource.nodeId]
        if (!nodeResources) {
            nodeResources = nodes[resource.nodeId] = {}
        }
        nodeResources[resource.id] = resource
    }
    return nodes
}

function reserveProcess (nodeResources, clusterReservation, resourceList) {
    let processReservation = {}
    for (let resource of resourceList) {
        let resourceCounter = resource.count
        log.debug('Looking for', resource.count, ' x ', resource.name)
        for(let resourceId of Object.keys(nodeResources)) {
            log.debug('Testing', resourceId)
            if (resourceCounter > 0) {
                let nodeResource = nodeResources[resourceId]
                if ((nodeResource.name == resource.name || nodeResource.alias.id == resource.name) && !clusterReservation[resourceId]) {
                    processReservation[resourceId] = nodeResource
                    resourceCounter--
                }
            }
        }
        if (resourceCounter > 0) {
            return null
        }
    }
    return processReservation
}

function reservationSummary (clusterReservation) {
    if (!clusterReservation) {
        return
    }
    let nodes = {}
    for(let resource of Object.keys(clusterReservation).map(k => clusterReservation[k])) {
        let resources = nodes[resource.nodeId]
        if (resources) {
            resources.push(resource)
        } else {
            nodes[resource.nodeId] = [resource]
        }
    }
    let summary = ''
    for(let nodeId of Object.keys(nodes)) {
        let nodeResources = nodes[nodeId]
        if (summary != '') {
            summary += ' + '
        }
        summary += nodeId + '['
        let first = true
        for(let type of nodeResources.map(r => r.type).filter((v, i, a) => a.indexOf(v) === i)) {
            let resourceIndices = nodeResources.filter(r => r.type == type).map(r => r.index)
            if (resourceIndices.length > 0) {
                if (!first) {
                    summary += ' + '
                }
                summary += type + ' ' + new MultiRange(resourceIndices.join(',')).getRanges()
                    .map(range => range[0] == range[1] ? range[0] : range[0] + '-' + range[1])
                    .join(',')
                first = false
            }
        }
        summary += ']'
    }
    return summary
}

async function allocate (clusterRequest, userId, job) {
    let simulation = !job
    let t
    try {
        t = await sequelize.transaction({ type: Sequelize.Transaction.TYPES.EXCLUSIVE })
        let options = { transaction: t, lock: t.LOCK }
        let nodes = await loadNodes(t, userId, simulation)
        let clusterReservation = {}
        for(let groupIndex = 0; groupIndex < clusterRequest.length; groupIndex++) {
            let groupRequest = clusterRequest[groupIndex]
            log.debug('Reserving process group', groupIndex)
            let jobProcessGroup
            if (!simulation) {
                jobProcessGroup = await ProcessGroup.create({ index: groupIndex }, options)
                log.debug('Adding process group', groupIndex)
                await job.addProcessgroup(jobProcessGroup, options)
            }
            for(let processIndex = 0; processIndex < groupRequest.count; processIndex++) {
                log.debug('Reserving process', processIndex, 'for process group', groupIndex)
                let processReservation
                let jobProcess
                if (!simulation) {
                    jobProcess = await Process.create({ index: processIndex }, options)
                    await jobProcessGroup.addProcess(jobProcess, options)
                }
                for (let nodeId of Object.keys(nodes)) {
                    let node = nodes[nodeId]
                    log.debug('Trying node', nodeId)
                    processReservation = reserveProcess(node, clusterReservation, groupRequest.process)
                    if (processReservation) {
                        log.debug('Successfully reserved process', processIndex, 'for process group', groupIndex, 'on node', nodeId)
                        if (!simulation) {
                            jobProcess.nodeId = nodeId
                            await jobProcess.save(options)
                        }
                        break
                    }
                }
                if (processReservation) {
                    clusterReservation = Object.assign(clusterReservation, processReservation)
                    if (!simulation) {
                        for(let resource of Object.keys(processReservation).map(k => processReservation[k])) {
                            await Allocation.create({
                                resourceId: resource.id,
                                processId:  jobProcess.id 
                            }, options)
                        }
                    }
                } else if (simulation) {
                    return false
                } else {
                    await t.rollback()
                    return false
                }
            }
        }
        if (!simulation) {
            job.allocation = reservationSummary(clusterReservation)
            log.debug('Successfully reserved job', job.id, job.allocation)
            await job.save(options)
            await t.commit()
        }
        return true
    } catch (err) {
        log.error(err)
        t && await t.rollback()
        throw err
    }
}

exports.canAllocate = (request, user) => allocate(request, user.id)
exports.tryAllocate = job => allocate(parseClusterRequest(job.request), job.userId, job)
