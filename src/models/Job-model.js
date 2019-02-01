const assign = require('assign-deep')
const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Pit = require('./Pit-model.js')
const Group = require('./Group-model.js')
const User = require('./User-model.js')
const State = require('./State-model.js')
const ProcessGroup = require('./ProcessGroup-model.js')
const Process = require('./Process-model.js')
const Allocation = require('./Allocation-model.js')

const log = require('../utils/logger.js')

var Job = sequelize.define('job', {
    id:           { type: Sequelize.INTEGER, primaryKey: true },
    description:  { type: Sequelize.STRING,  allowNull: false },
    provisioning: { type: Sequelize.STRING,  allowNull: false },
    request:      { type: Sequelize.STRING,  allowNull: false },
    image:        { type: Sequelize.STRING,  allowNull: true },
    state:        { type: Sequelize.INTEGER, allowNull: true },
    since:        { type: Sequelize.DATE,    allowNull: true },
    rank:         { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    allocation:   { type: Sequelize.STRING,  allowNull: true },
    continues:    { type: Sequelize.INTEGER, allowNull: true }
})

Job.jobStates = {
    NEW: 0,
    PREPARING: 1,
    WAITING: 2,
    STARTING: 3,
    RUNNING: 4,
    STOPPING: 5,
    CLEANING: 6,
    DONE: 7
}

Job.hasMany(State, { onDelete: 'cascade' })
State.belongsTo(Job)

Job.hasMany(ProcessGroup, { onDelete: 'cascade' })
ProcessGroup.belongsTo(Job)

Job.belongsTo(Pit, { foreignKey: 'id', onDelete: 'cascade' })

Job.belongsTo(User)

var JobGroup = Job.JobGroup = sequelize.define('jobgroup', {
    jobId:        { type: Sequelize.INTEGER, unique: 'pk' },
    groupId:      { type: Sequelize.STRING,  unique: 'pk' }
})
Job.hasMany(JobGroup, { onDelete: 'cascade' })
Group.hasMany(JobGroup, { onDelete: 'cascade' })
JobGroup.belongsTo(Job)
JobGroup.belongsTo(Group)

User.prototype.canAccessJob = async function (job) {
    if (this.admin || job.userId == this.id) {
        return true
    }
    return await Job.findOne({
        where: { id: job.id, '$jobgroups->group->usergroups.userId$': this.id },
        include: [
            {
                model: JobGroup,
                require: true,
                include: [
                    {
                        model: Group,
                        require: true,
                        include: [
                            {
                                model: User.UserGroup,
                                require: true
                            }
                        ]
                    }
                ]
            }
        ]
    })
}

Job.getDir = (jobId) => Pit.getDir(jobId)
Job.prototype.getDir = function () {
    return Pit.getDir(this.id)
} 

Job.getDirExternal = (jobId) => Pit.getDirExternal(jobId)
Job.prototype.getDirExternal = function () {
    return Pit.getDirExternal(this.id)
}

Job.prototype.setState = async function (state, reason) {
    if (this.state == state) {
        return
    }
    let t
    try {
        t = await sequelize.transaction({ type: Sequelize.Transaction.TYPES.EXCLUSIVE })
        if (this.state != Job.jobStates.WAITING && state == Job.jobStates.WAITING) {
            this.rank = ((await Job.max('rank', { where: { state: Job.jobStates.WAITING } })) || 0) + 1
        } else if (this.state == Job.jobStates.WAITING && state != Job.jobStates.WAITING) {
            await Job.update(
                { rank: Sequelize.literal('rank - 1') }, 
                { 
                    where: { 
                        state: Job.jobStates.WAITING, 
                        rank: { [Sequelize.Op.gt]: this.rank } 
                    },
                    transaction: t, 
                    lock: t.LOCK
                }
            )
            this.rank = 0
        }
        this.state = state
        this.since = Date.now()
        await this.save({ transaction: t, lock: t.LOCK })
        await State.create({ jobId: this.id, state: state, since: Date.now(), reason: reason })
        await t.commit()
    } catch (err) {
        await t.rollback()
        throw err
    }
}

Job.infoQuery = options => assign({
    subQuery: false,
    include: [
        {
            model: ProcessGroup,
            require: false,
            attributes: [],
            include: [
                {
                    model: Process,
                    require: false,
                    attributes: [],
                    include: 
                    [
                        {
                            model: Allocation,
                            require: false,
                            attributes: []
                        }
                    ]
                }
            ]
        }
    ],
    group: [
        'job.id'
    ],
    attributes: {
        include: [
            [sequelize.fn('sum',   sequelize.col('processgroups->processes->allocations.samples')),  'samples'],
            [sequelize.fn('sum',   sequelize.col('processgroups->processes->allocations.acompute')), 'aggcompute'],
            [sequelize.fn('sum',   sequelize.col('processgroups->processes->allocations.amemory')),  'aggmemory'],
            [sequelize.fn('avg',   sequelize.col('processgroups->processes->allocations.ccompute')), 'curcompute'],
            [sequelize.fn('avg',   sequelize.col('processgroups->processes->allocations.cmemory')),  'curmemory']
        ]
    }
}, options || {})

Allocation.activeQuery = {
    include: [
        {
            model: Process,
            require: true,
            attributes: [],
            include: [
                {
                    model: ProcessGroup,
                    require: true,
                    attributes: [],
                    include: [
                        {
                            model: Job,
                            require: true,
                            attributes: []
                        }
                    ]
                }
            ]
        }
    ],
    where: { 
        '$process->processgroup->job.state$': { 
            [Sequelize.Op.gte]: Job.jobStates.STARTING, 
            [Sequelize.Op.lte]: Job.jobStates.STOPPING 
        } 
    }
}

module.exports = Job
