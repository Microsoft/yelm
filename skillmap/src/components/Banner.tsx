import * as React from "react";
import { connect } from 'react-redux';

import { SkillMapState } from '../store/reducer';

interface BannerProps {
    title: string;
    description: string;
    icon: string;
}

export class BannerImpl extends React.Component<BannerProps> {
    render() {
        const  { title, description, icon } = this.props;
        return <div className="banner">
            <div className="banner-card">
                <i className={`icon ${icon}`} />
                <div className="banner-text">
                    <div className="banner-title">{title}</div>
                    <div className="banner-description">{description}</div>
                </div>
            </div>
        </div>
    }
}

function mapStateToProps(state: SkillMapState, ownProps: any) {
    return {
        title: state.title,
        description: state.description
    };
}

export const Banner = connect(mapStateToProps)(BannerImpl);