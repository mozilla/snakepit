const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Pit = require('./Pit-model.js')
const Group = require('./Group-model.js')
const User = require('./User-model.js')
const State = require('./State-model.js')
const ProcessGroup = require('./ProcessGroup-model.js')

var Job = sequelize.define('job', {
    id:         { type: Sequelize.INTEGER, primaryKey: true },
    title:      { type: Sequelize.STRING,  allowNull: false },
    request:    { type: Sequelize.STRING,  allowNull: false },
    state:      { type: Sequelize.INTEGER, allowNull: false },
    continues:  { type: Sequelize.INTEGER, allowNull: true }
})

Job.jobStates = {
    NEW: 0,
    PREPARING: 1,
    WAITING: 2,
    STARTING: 3,
    RUNNING: 4,
    STOPPING: 5,
    CLEANING: 6,
    DONE: 7,
    ARCHIVED: 8
}

Job.belongsTo(Pit, { foreignKey: 'id' })

Job.hasMany(State)

Job.hasMany(ProcessGroup)

var JobGroup = sequelize.define('jobgroup')
Job.belongsToMany(Group, { through: JobGroup })
Group.belongsToMany(Job, { through: JobGroup })

User.prototype.canAccessJob = async (job) => {
    if (this.admin || await job.hasUser(this)) {
        return true
    }
    return (await Job.count({ 
        where: { id: job.id }, 
        include: [
            { model: JobGroup },
            { model: User.UserGroup },
            { model: User, where: { id: this.id } }
        ]
    }) > 0)
}

Job.prototype.getJobDir = () => Pit.getPitDir(this.id)

Job.prototype.setState = async (state, reason) => {
    let transaction
    try {
        transaction = await sequelize.transaction()
        this.state = state
        await this.save()
        await this.addState({ state: state, since: Date.now(), reason: reason })
        await transaction.commit()
    } catch (err) {
        await transaction.rollback()
        throw err
    }
}

module.exports = Job
