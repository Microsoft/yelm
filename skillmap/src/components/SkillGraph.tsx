import * as React from "react";
import { connect } from 'react-redux';

import { SkillMapState } from '../store/reducer';
import { dispatchChangeSelectedItem, dispatchShowCompletionModal,
    dispatchSetSkillMapCompleted, dispatchOpenActivity, dispatchShowCarryoverModal } from '../actions/dispatch';
import { GraphNode } from './GraphNode';
import { GraphPath } from "./GraphPath";

import { getActivityStatus, isCodeCarryoverEnabled } from '../lib/skillMapUtils';
import { SvgGraphItem, SvgGraphPath } from '../lib/skillGraphUtils';
import { tickEvent } from "../lib/browserUtils";

export interface SkillGraphProps {
    // Rendering
    unit: number;
    items: SvgGraphItem[];
    paths: SvgGraphPath[];
    width: number;
    height: number;

    // Skill map
    map: SkillMap;
    user: UserState;
    selectedActivityId?: string;
    pageSourceUrl: string;
    theme: SkillGraphTheme;
    completionState: "incomplete" | "transitioning" | "completed";

    // Events
    dispatchChangeSelectedItem: (mapId?: string, activityId?: string) => void;
    dispatchShowCompletionModal: (mapId: string, activityId?: string) => void;
    dispatchSetSkillMapCompleted: (mapId: string) => void;
    dispatchOpenActivity: (mapId: string, activityId: string) => void;
    dispatchShowCarryoverModal: (mapId: string, activityId: string) => void;
}

class SkillGraphImpl extends React.Component<SkillGraphProps> {
    constructor(props: SkillGraphProps) {
        super(props);
    }

    protected onItemSelect = (activityId: string, kind: MapNodeKind) => {
        const { user, pageSourceUrl, map, completionState, selectedActivityId,
            dispatchChangeSelectedItem, dispatchShowCompletionModal } = this.props;

        const { status } = getActivityStatus(user, pageSourceUrl, map, activityId);
        if (kind === "completion" && status === "completed") {
            tickEvent("skillmap.graph.reward.select", { path: map.mapId, activity: activityId})
            dispatchChangeSelectedItem(map.mapId, activityId);
            dispatchShowCompletionModal(map.mapId, activityId)
        } else {
            if (activityId !== selectedActivityId) {
                tickEvent("skillmap.graph.item.select", { path: map.mapId, activity: activityId })
                dispatchChangeSelectedItem(map.mapId, activityId);
            } else {
                tickEvent("skillmap.graph.item.deselect", { path: map.mapId, activity: activityId })
                dispatchChangeSelectedItem(undefined);
            }
        }
    }

    protected onItemDoubleClick = (activityId: string, kind: MapNodeKind) => {
        const { user, pageSourceUrl, map, dispatchOpenActivity, dispatchShowCarryoverModal } = this.props;
        const { status } = getActivityStatus(user, pageSourceUrl, map, activityId);
        const activity = map.activities[activityId];
        tickEvent("skillmap.activity.open.doubleclick", { path: map.mapId, activity: activityId, status: status || "" });

        if (isCodeCarryoverEnabled(user, pageSourceUrl, map, activity)) {
            dispatchShowCarryoverModal(map.mapId, activityId);
        } else if (kind == "activity") {
            dispatchOpenActivity(map.mapId, activityId);
        }
    }

    componentDidUpdate(props: SkillGraphProps) {
        if (props.completionState === "transitioning") {
            setTimeout(() => {
                tickEvent("skillmap.graph.reward.auto", { path: props.map.mapId, activity: props.selectedActivityId || "" })
                props.dispatchSetSkillMapCompleted(props.map.mapId)
                props.dispatchShowCompletionModal(props.map.mapId, props.selectedActivityId)
            }, 400);
        }
    }

    render() {
        const { unit, items, paths, map, user, selectedActivityId, pageSourceUrl, theme } = this.props;

        return <g className="skill-graph">
            <g opacity={theme.pathOpacity}>
                {paths.map((el, i) => {
                    return <GraphPath key={`graph-activity-${i}`} strokeWidth={3 * unit} color={theme.strokeColor} points={el.points} />
                })}
                {paths.map((el, i) => {
                    return <GraphPath key={`graph-activity-${i}`} strokeWidth={3 * unit - 4} color={theme.pathColor}  points={el.points} />
                })}
            </g>
            {items.map((el, i) => {
                return <GraphNode key={`graph-activity-${i}`}
                    theme={theme}
                    kind={el.activity.kind}
                    activityId={el.activity.activityId}
                    position={el.position}
                    width={5 * unit}
                    selected={el.activity.activityId === selectedActivityId}
                    onItemSelect={this.onItemSelect}
                    onItemDoubleClick={this.onItemDoubleClick}
                    status={getActivityStatus(user, pageSourceUrl, map, el.activity.activityId).status} />
            })}
        </g>
    }
}

function mapStateToProps(state: SkillMapState, ownProps: any) {
    if (!state) return {};

    const mapProgress = state.user?.mapProgress?.[state.pageSourceUrl];
    return {
        user: state.user,
        pageSourceUrl: state.pageSourceUrl,
        theme: state.theme,
        selectedActivityId: state.selectedItem && ownProps.map?.mapId == state.selectedItem.mapId ? state.selectedItem.activityId : undefined,
        completionState: mapProgress?.[ownProps.map.mapId]?.completionState
    }
}

const mapDispatchToProps = {
    dispatchChangeSelectedItem,
    dispatchShowCompletionModal,
    dispatchSetSkillMapCompleted,
    dispatchOpenActivity,
    dispatchShowCarryoverModal
};

export const SkillGraph = connect(mapStateToProps, mapDispatchToProps)(SkillGraphImpl);
