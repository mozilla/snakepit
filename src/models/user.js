router.getHomeDir = () => {
    let homeDir = '/data/home/' + user.id
    if (!fs.existsSync(homeDir)) {
        fs.mkdirSync(homeDir)
    }
    return homeDir
}