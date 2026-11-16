import { connect } from './cdp.mjs'
const A = await connect(9222)
console.log(await A.eval(`(() => {
  const t = window.__tiles, v = t.viewer, ts = t.tileset
  const p = v.camera.positionWC
  const root = ts.root
  return JSON.stringify({
    cam: [p.x, p.y, p.z],
    camDir: [v.camera.directionWC.x, v.camera.directionWC.y, v.camera.directionWC.z],
    rootContentReady: root?.contentReady,
    rootContentState: root?.content?.resource?.state ?? root?._contentState,
    rootHasContent: !!root?.content,
    selected: ts._selectedTiles?.length,
    visible: ts._visible,
    boundingSphere: [ts.boundingSphere.center.x, ts.boundingSphere.center.y, ts.boundingSphere.center.z, ts.boundingSphere.radius],
    globeShow: v.scene.globe.show,
    flying: !!v.camera._currentFlightId,
    near: v.camera.frustum.near, far: v.camera.frustum.far,
  })
})()`))
A.close()