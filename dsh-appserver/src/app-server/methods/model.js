export function modelMethods(adapter) {
  const describe = () => adapter.describeModels()
  const catalog = () => adapter.catalogModels()
  const discover = p => adapter.discoverModels(p.request || p)
  const upsert = p => adapter.configureModel(p.route, p.profile, p.expectedRevision)
  const remove = p => adapter.deleteModel(p.route, p.expectedRevision)
  return {
    'model/list': discover,
    'model/config/read': describe,
    'models/catalog': catalog,
    'model/config/upsert': upsert,
    'model/config/remove': remove,
    'models/describe': describe,
    'models/discover': discover,
    'models/upsert': upsert,
    'models/remove': remove,
    'flowix.bridge.models.describe': describe,
    'flowix.bridge.models.discover': discover,
    'flowix.bridge.models.upsert': upsert,
    'flowix.bridge.models.remove': remove,
  }
}
