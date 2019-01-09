const Sequelize = require('sequelize')
const sequelize = require('./db.js')

const fs = require('fs-extra')

const pitPrefix = '/data/pits/'

var Pit = sequelize.define('pit', {
    id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true }
})

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

module.exports = Pit
