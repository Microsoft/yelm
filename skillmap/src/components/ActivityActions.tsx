import * as React from "react";
import { connect } from 'react-redux';

import { dispatchOpenActivity, dispatchShowRestartActivityWarning, dispatchShowShareModal, dispatchShowCarryoverModal } from '../actions/dispatch';

import { ActivityStatus, lookupActivityProgress, isCodeCarryoverEnabled } from '../lib/skillMapUtils';
import { tickEvent } from '../lib/browserUtils';
import { editorUrl } from "./makecodeFrame";
import { SkillMapState } from "../store/reducer";

interface OwnProps {
    mapId: string;
    activityId: string;
    status?: ActivityStatus;
    completedHeaderId?: string;
    showCodeCarryoverModal?: boolean;
}

interface DispatchProps {
    dispatchOpenActivity: (mapId: string, activityId: string) => void;
    dispatchShowRestartActivityWarning: (mapId: string, activityId: string) => void;
    dispatchShowShareModal: (mapId: string, activityId: string) => void;
    dispatchShowCarryoverModal: (mapId: string, activityId: string) => void;
}

type ActivityActionsProps = OwnProps & DispatchProps;

export class ActivityActionsImpl extends React.Component<ActivityActionsProps> {
    protected getActivityActionText(): string {
        switch (this.props.status) {
            case "locked":
                return lf("LOCKED");
            case "completed":
                return lf("VIEW CODE");
            case "inprogress":
            case "restarted":
                return lf("CONTINUE");
            case "notstarted":
            default:
                return lf("START");
        }
    }

    protected isCompleted(status: ActivityStatus): boolean {
        return status === "completed" || status === "restarted";
    }

    protected handleActionButtonClick = () => {
        const { status, mapId, activityId, dispatchOpenActivity, dispatchShowCarryoverModal, showCodeCarryoverModal } = this.props;

        switch (status) {
            case "locked":
                break;
            case "completed":
            case "inprogress":
            case "notstarted":
            case "restarted":
            default:
                tickEvent("skillmap.activity.open", { path: mapId, activity: activityId, status: status || "" });

                if (showCodeCarryoverModal) {
                    dispatchShowCarryoverModal(mapId, activityId);
                }
                else {
                    dispatchOpenActivity(mapId, activityId);
                }
        }
    }

    protected handleRestartButtonClick = () => {
        const { mapId, activityId, status, dispatchShowRestartActivityWarning } = this.props;
        tickEvent("skillmap.sidebar.restart", { path: mapId, activity: activityId, status: status || "" });
        dispatchShowRestartActivityWarning(mapId, activityId);
    }

    protected handleShareButtonClick = () => {
        const { mapId, activityId, status, dispatchShowShareModal } = this.props;
        tickEvent("skillmap.sidebar.share", { path: mapId, activity: activityId, status: status || "" });
        dispatchShowShareModal(mapId, activityId);
    }

    protected handleSaveToProjectsClick = () => {
        const { completedHeaderId, mapId, activityId } = this.props;
        tickEvent("skillmap.export", { path: mapId || "", activity: activityId || "" });
        window.open(`${editorUrl}#skillmapimport:${completedHeaderId}`)
    }

    render() {
        const { status, completedHeaderId } = this.props;
        const activityStarted = (status && status !== "notstarted" && status !== "locked");

        if (status === "locked") return <div />

        // Apply "grid" class when there are four actions (for a completed activity)
        return <div className={`actions ${completedHeaderId ? "grid" : ""}`}>
            <div className="action-button" role="button" onClick={this.handleActionButtonClick}>
                {this.getActivityActionText()}
            </div>
            {activityStarted && <div className="action-button" role="button" onClick={this.handleRestartButtonClick}>
                {lf("Restart")}
            </div>}
            {activityStarted && <div className="action-button" role="button" onClick={this.handleShareButtonClick}>
                {lf("Share")}
            </div>}
            {completedHeaderId && <div className="action-button" role="button" onClick={this.handleSaveToProjectsClick}>
                {lf("Save to My Projects")}
            </div>}
        </div>
    }
}

function mapStateToProps(state: SkillMapState, ownProps: any) {
    if (!state) return {};

    const props = ownProps as OwnProps;
    const map = state.maps[props.mapId];
    const activity = map.activities[props.activityId] as MapActivity;
    return {
        showCodeCarryoverModal: isCodeCarryoverEnabled(state.user, state.pageSourceUrl, map, activity)
    };
}

const mapDispatchToProps = {
    dispatchOpenActivity,
    dispatchShowRestartActivityWarning,
    dispatchShowShareModal,
    dispatchShowCarryoverModal
}

export const ActivityActions = connect(mapStateToProps, mapDispatchToProps)(ActivityActionsImpl);