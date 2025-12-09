# Axis Bank Content Wand

A powerful Figma plugin that audits and improves design copy based on content design system guidelines. With a single click, analyze text layers or entire frames and get instant recommendations for content improvements.

## Features

- **One-Click Analysis**: Select text layers or frames and analyze content compliance
- **Intelligent Recommendations**: Get specific suggestions for improving copy based on guidelines
- **Bulk Fixes**: Apply all recommended fixes at once with the "Fix All" button
- **Optimized Analysis**: Smart caching and compliance detection skips already compliant content
- **Real-time Feedback**: See violations and suggested improvements instantly

## How It Works

1. Select text layers or a frame in your Figma design
2. Click "Analyze" to audit the content
3. Review recommendations and apply fixes individually or bulk

The plugin connects to our content linting API at `https://content-lint.vercel.app` to analyze text against established content design system guidelines.

## Requirements

- Figma Desktop app
- Internet connection for API calls

## Installation

1. Clone this repository
2. Open Figma Desktop
3. Go to Plugins > Development > Import plugin from manifest...
4. Select the `manifest.json` file from this repository

## Development Setup

This plugin uses TypeScript and NPM. To set up the development environment:

1. Download Node.js which comes with NPM: https://nodejs.org/en/download/
2. Install dependencies: `npm install`
3. Install TypeScript: `npm install -g typescript`
4. Install Figma plugin typings: `npm run typings`
5. Build the plugin: `npm run build`
6. For development, use: `npm run watch` to auto-compile TypeScript changes

## API Integration

The plugin integrates with a backend API for content analysis. The API endpoint is configured in the plugin code and requires network access permissions.


## By

Built with ❤️ by Karan + LLMs
