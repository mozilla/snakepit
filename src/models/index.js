const glob = require( 'glob' )
const path = require( 'path' )

glob.sync('./*-model.js').forEach(moduleName => {
    let modelName = moduleName.substr(0, moduleName.indexOf('-'))
    module[modelName] = require(path.resolve(moduleName))
})
module.sequelize = require('./db.js')