const Sequelize = require('sequelize')
const sequelize = require('./db.js')

var Alias = sequelize.define('alias', {
    id:         { type: Sequelize.STRING },
    name:       { type: Sequelize.STRING }
})

Alias.getAlias = async name => {
    let entry = await Alias.findOne({ where: { name: name } }, { rejectOnEmpty: false })
    return entry && entry.alias
}

module.exports = Alias
