const { MultiRange } = require('multi-integer-range')
const Node = require('./models/Node-model.js')
const Resource = require('./models/Resource-model.js')
const Job = require('./models/Job-model.js')
const ProcessGroup = require('./models/ProcessGroup-model.js')
const Process = require('./models/Process-model.js')
const Allocation = require('./models/Allocation-model.js')
const Sequelize = require('sequelize')

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
                transaction: transaction,
                lock: transaction.LOCK,
                where: nodeWhere 
            },
            { 
                model: Allocation, 
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
                        where: { state: { between: [Job.jobStates.STARTING, Job.jobStates.STOPPING] } }
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
                                require: true,
                                attributes: [],
                                transaction: transaction,
                                lock: transaction.LOCK,
                                include: [
                                    {
                                        model: User,
                                        require: true,
                                        attributes: [],
                                        where: { id: userId }
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
        attributes: [
            'id',
            'node',
            'type',
            'index',
            'name',
            [sequelize.fn('count', sequelize.col('job.id')), 'usecount'],
            [sequelize.fn('count', sequelize.col('user.id')), 'accesscount'],
            [sequelize.fn('count', sequelize.col('group.id')), 'groupcount']
        ],
        group: ['resource.id'],
        where: {
            'usecount': 0,
            [Sequelize.Op.or]: [
                { 'groupcount': 0 }, 
                { 'accesscount': { [Sequelize.Op.gt]: 0 } }
            ]
        }
    })
    for (let resource of resources) {
        let nodeResources = nodes[resource.node]
        if (!nodeResources) {
            nodeResources = nodes[resource.node] = {}
        }
        nodeResources[resource.id] = resources
    }
    return nodes
}

function reserveProcess (node, clusterReservation, resourceList) {
    if (!node || !node.resources) {
        return null
    }
    let processReservation = {}
    for (let resource of resourceList) {
        let resourceCounter = resource.count
        //console.log('Looking for ' + resource.count + ' x ' + resource.name)
        let name = db.aliases[resource.name] ? db.aliases[resource.name].name : resource.name
        for(let resourceId of Object.keys(node.resources)) {
            //console.log('Testing ' + resourceId)
            if (resourceCounter > 0) {
                let nodeResource = node.resources[resourceId]
                if (nodeResource.name == name && !clusterReservation[resourceId]) {
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
        let resources = nodes[resource.node]
        if (resources) {
            resources.push(resource)
        } else {
            nodes[resource.node] = [resource]
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
        let nodes = await loadNodes(t, userId, simulation)
        let clusterReservation = {}
        for(let groupIndex = 0; groupIndex < clusterRequest.length; groupIndex++) {
            let groupRequest = clusterRequest[groupIndex]
            let jobProcessGroup
            if (!simulation) {
                jobProcessGroup = await ProcessGroup.create({ index: groupIndex })
                await job.addProcessGroup(jobProcessGroup)
            }
            for(let processIndex = 0; processIndex < groupRequest.count; processIndex++) {
                let processReservation
                let jobProcess
                if (!simulation) {
                    jobProcess = await Process.create({ index: processIndex })
                    await jobProcessGroup.addProcess(jobProcess)
                }
                for (let node of nodes) {
                    processReservation = reserveProcess(node, clusterReservation, groupRequest.process)
                    if (processReservation) {
                        break
                    }
                }
                if (processReservation) {
                    clusterReservation = Object.assign(clusterReservation, processReservation)
                    for(let resource of Object.keys(processReservation).map(k => processReservation[k])) {
                        let allocation = await Allocation.create()
                        await jobProcess.addAllocation(allocation)
                        await allocation.addResource(resource)
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
            await job.save()
            await t.commit()
        }
        return true
    } catch (err) {
        await t.rollback()
        throw err
    }
}

exports.canAllocate = (request, user) => allocate(request, user.id)
exports.tryAllocate = job => allocate(job.request, job.userId, job)
