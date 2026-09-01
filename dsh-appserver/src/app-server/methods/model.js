export function modelMethods(adapter) {
  const describe = () => adapter.describeModels()
  const catalog = () => adapter.catalogModels()
  const discover = p => adapter.discoverModels(p.request || p)
  const upsert = p => adapter.configureModel(p.route, p.profile, p.expectedRevision)
  const remove = p => adapter.deleteModel(p.route, p.expectedRevision)
  return {
    'model/config/read': describe,
    'model/catalog': catalog,
    'model/discover': discover,
    'model/config/upsert': upsert,
    'model/config/remove': remove,
  }
}
