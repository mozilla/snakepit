const Sequelize = require('sequelize')
const sequelize = require('./db.js')
const Group = require('./Group-model.js')
const State = require('./State-model.js')
const ProcessGroup = require('./ProcessGroup-model.js')

var Job = sequelize.define('job', {
    title:      { type: Sequelize.STRING,  allowNull: false },
    request:    { type: Sequelize.STRING,  allowNull: false },
    continues:  { type: Sequelize.INTEGER, allowNull: true }
})

Job.hasMany(State)

Job.hasMany(ProcessGroup)

Job.belongsToMany(Group, { through: 'JobGroup' })
Group.belongsToMany(Job, { through: 'JobGroup' })

User.prototype.canAccessJob = async (resource) => {
    // TODO: Implement DB based decision
    /*
    if (this.admin || this.id == job.user) {
        return true
    }
    if (job.groups && this.groups) {
        for (let group of this.groups) {
            if (job.groups.includes(group)) {
                return true
            }
        }
    }
    return false
    */
    return true
}

module.exports = Job
