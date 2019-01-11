const Sequelize = require('sequelize')
const sequelize = require('./db.js')

const fs = require('fs-extra')

var Pit = sequelize.define('pit', {
    id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true }
})

const pitPrefix = '/data/pits/'

Pit.afterCreate(async pit => {
    let pitDir = pitPrefix + pit.id
    if (!(await fs.pathExists(pitDir))) {
        await fs.mkdirp(pitDir)
    }
})

Pit.afterDestroy(async pit => {
    let pitDir = pitPrefix + pit.id
    if (await fs.pathExists(pitDir)) {
        await fs.remove(pitDir)
    }
})

Pit.getPitDir = (pitId) => pitPrefix + pitId
Pit.prototype.getPitDir = function () {
    return Pit.getPitDir(this.id)
}

module.exports = Pit
