const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Pit = require('./Pit-model.js')
const Group = require('./Group-model.js')
const User = require('./User-model.js')
const State = require('./State-model.js')
const ProcessGroup = require('./ProcessGroup-model.js')

var Job = sequelize.define('job', {
    id:           { type: Sequelize.INTEGER, primaryKey: true },
    description:  { type: Sequelize.STRING,  allowNull: false },
    provisioning: { type: Sequelize.STRING,  allowNull: false },
    request:      { type: Sequelize.STRING,  allowNull: false },
    state:        { type: Sequelize.INTEGER, allowNull: false },
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

Job.hasMany(State)

Job.hasMany(ProcessGroup)

Job.belongsTo(Pit, { foreignKey: 'id' })

Job.belongsTo(User)

var JobGroup = Job.JobGroup = sequelize.define('jobgroup')
Job.belongsToMany(Group, { through: JobGroup })
Group.belongsToMany(Job, { through: JobGroup })

User.prototype.canAccessJob = async (job) => {
    if (this.admin || await job.hasUser(this)) {
        return true
    }
    return await job.hasOne({
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
                                require: true,
                                include: [
                                    {
                                        model: User,
                                        require: true,
                                        where: { id: this.id }
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ]
    })
}

Job.prototype.getJobDir = function () {
    return Pit.getDir(this.id)
} 

Job.prototype.setState = async (state, reason) => {
    if (this.state == state) {
        return
    }
    let t
    try {
        t = await sequelize.transaction({ type: Sequelize.Transaction.TYPES.EXCLUSIVE })
        let stateData = { state: state, since: Date.now(), reason: reason }
        let stateEntry = await this.getState({ where: { state: state }, transaction: t, lock: t.LOCK })
        n = new State
        if (stateEntry) {
            stateEntry.since = Date.now()
            stateEntry.reason = reason
            stateEntry.update({ transaction: t, lock: t.LOCK })
        } else {
            await this.addState(stateData, { transaction: t, lock: t.LOCK })
        }
        if (this.state != Job.jobStates.WAITING && state == Job.jobStates.WAITING) {
            this.rank = ((await Job.max('rank', { where: { state: Job.jobStates.WAITING }, transaction: t, lock: t.LOCK })) || 0) + 1
        } else if (this.state == Job.jobStates.WAITING && state != Job.jobStates.WAITING) {
            await Job.update(
                { rank: Sequelize.literal('rank - 1') }, 
                { 
                    where: { 
                        state: Job.jobStates.WAITING, 
                        rank: { [gt]: this.rank } 
                    },
                    transaction: t, 
                    lock: t.LOCK
                }
            )
            this.rank = 0
        }
        this.state = state
        await this.save({ transaction: t, lock: t.LOCK })
        await t.commit()
    } catch (err) {
        await t.rollback()
        throw err
    }
}

module.exports = Job
