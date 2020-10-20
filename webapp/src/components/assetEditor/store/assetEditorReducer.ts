import * as actions from '../actions/types'

export const enum GalleryView {
    User,
    Gallery
}

export interface AssetEditorState {
    view: GalleryView;
    assets: pxt.Asset[];
    selectedAsset?: pxt.Asset;
}

const initialState: AssetEditorState = {
    view: GalleryView.User,
    assets: []
}

const topReducer = (state: AssetEditorState = initialState, action: any): AssetEditorState => {
    switch (action.type) {
        case actions.CHANGE_SELECTED_ASSET:
            return {
                ...state,
                selectedAsset: getSelectedAsset(state.assets, action.assetType, action.assetId)
            };
        case actions.CHANGE_GALLERY_VIEW:
            return {
                ...state,
                view: action.view
            };
        case actions.UPDATE_USER_ASSETS:
            const assets = getUserAssets();
            return {
                ...state,
                selectedAsset: state.selectedAsset ? assets.find(el => el.id == state.selectedAsset.id) : undefined,
                assets
            }
        default:
            return state
    }
}

function compareInternalId(a: pxt.Asset, b: pxt.Asset) {
    return a.internalID - b.internalID;
}

function getSelectedAsset(assets: pxt.Asset[], type: pxt.AssetType, id: string) {
    if (!type || !id) return undefined;

    return assets.find(el => el.type == type && el.id == id);
}

function getUserAssets() {
    const project = pxt.react.getTilemapProject();
    const imgConv = new pxt.ImageConverter();

    const imageToGalleryItem = (image: pxt.ProjectImage | pxt.Tile) => {
        let asset = image as pxt.Asset;
        asset.previewURI = imgConv.convert("data:image/x-mkcd-f," + image.jresData);
        return asset;
    };

    const tilemapToGalleryItem = (asset: pxt.ProjectTilemap) => {
        let tilemap = asset.data.tilemap;
        asset.previewURI = pxtblockly.tilemapToImageURI(asset.data, Math.max(tilemap.width, tilemap.height), false);
        return asset;
    };

    const animationToGalleryItem = (asset: pxt.Animation) => {
        if (asset.frames?.length <= 0) return null;
        let bitmap = pxt.sprite.Bitmap.fromData(asset.frames[0]);
        asset.previewURI = imgConv.convert("data:image/x-mkcd-f," + pxt.sprite.base64EncodeBitmap(bitmap.data()));
        return asset;
    };

    const images = project.getAssets(pxt.AssetType.Image).map(imageToGalleryItem).sort(compareInternalId);
    const tiles = project.getAssets(pxt.AssetType.Tile).map(imageToGalleryItem)
        .filter(t => !t.id.match(/^myTiles.transparency(8|16|32)$/gi)).sort(compareInternalId);
    const tilemaps = project.getAssets(pxt.AssetType.Tilemap).map(tilemapToGalleryItem).sort(compareInternalId);
    const animations = project.getAssets(pxt.AssetType.Animation).map(animationToGalleryItem);

    return images.concat(tiles).concat(tilemaps).concat(animations);
}

export default topReducer;