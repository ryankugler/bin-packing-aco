# 2D Rectangle Packing with Ant Colony Optimization

## Overview

This project implements a 2D rectangle packing algorithm using Ant Colony Optimization (ACO). The goal is to efficiently pack a set of rectangles of varying dimensions into a fixed-size bin with minimal unused space. The project includes a dynamic visualization to observe the packing process in real-time.

## Table of Contents

- [Background](#background)
  - [2D Bin Packing Problem](#2d-bin-packing-problem)
  - [Ant Colony Optimization (ACO)](#ant-colony-optimization-aco)
  - [Heuristic Used](#heuristic-used)
- [Algorithm](#algorithm)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Customization](#customization)
- [Visualization](#visualization)
- [Contributing](#contributing)
- [License](#license)

## Background

### 2D Bin Packing Problem

The 2D Bin Packing Problem is a classic optimization problem where a set of rectangles must be packed into a larger rectangular bin or container. The objective is to minimize the unused space in the bin, which often translates to minimizing the number of bins used or maximizing the utilization of a given bin. This problem has applications in various fields, such as cutting stock problems, warehouse storage, and VLSI design.

The problem is NP-hard, meaning that finding the optimal solution is computationally challenging, especially as the number of rectangles increases. Therefore, heuristic and metaheuristic approaches, like Ant Colony Optimization, are commonly used to find near-optimal solutions in a reasonable time.

### Ant Colony Optimization (ACO)

Ant Colony Optimization is a metaheuristic inspired by the foraging behavior of ants. Ants communicate indirectly through pheromone trails, which influence the paths chosen by other ants. Over time, paths that lead to food sources are reinforced with more pheromones, leading to an emergent optimization process.

In the context of the 2D bin packing problem, ACO is used to simulate ants that explore different configurations of packing rectangles. The pheromones guide the ants towards promising configurations, encouraging exploration of solutions that pack the rectangles more efficiently.

### Heuristic Used

In this implementation, we use a heuristic based on the area of the rectangles. Larger rectangles are given higher priority when being placed in the bin, as they are typically more challenging to fit in later stages of the packing process. The heuristic is calculated as the square of the rectangle's area:

\[ \text{Heuristic} = (\text{width} \times \text{height})^2 \]

This heuristic ensures that the ACO algorithm tends to place larger rectangles first, reducing the chances of leaving large, awkward spaces in the bin that are difficult to fill later.

## Algorithm

The algorithm used in this project is a combination of Ant Colony Optimization and a heuristic-driven packing strategy. Below is a step-by-step outline of the process:

1. **Initialization**:
   - Generate a set of random rectangles with dimensions within specified limits.
   - Initialize pheromones for each rectangle to guide the ACO process.

2. **Ant Simulation**:
   - Each ant simulates the packing of rectangles into the bin.
   - Rectangles are selected based on a probability influenced by pheromones and the heuristic (area of the rectangles).
   - Rectangles are attempted to be packed in the bin, considering both their original and rotated orientations.

3. **Pheromone Update**:
   - After all ants have completed their packing simulations, the pheromones are updated based on the quality (fitness) of the solutions found.
   - Solutions with lower unused space (higher packing efficiency) reinforce the pheromone trails.

4. **Iteration**:
   - The process is repeated for a specified number of iterations.
   - The best solution found across all iterations is selected as the final packing configuration.

5. **Visualization**:
   - The packing process is visualized in real-time, showing both the packed rectangles and the remaining rectangles in separate panes.

## Features

- **Ant Colony Optimization**: Leverages ACO to explore various packing configurations and find the optimal or near-optimal arrangement.
- **Heuristic-Driven Packing**: Uses a heuristic based on rectangle area to prioritize packing larger rectangles first.
- **Dynamic Visualization**: Includes a real-time animation of the packing process, helping to understand how the algorithm works.
- **Modular Code Structure**: Organized into modular components, making it easy to extend and maintain.

## Installation

To set up this project on your local machine, follow these steps:

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/your-username/2d-rectangle-packing-aco.git
   cd 2d-rectangle-packing-aco
   ```

2. **Install Dependencies**:
   The project relies on Python and several libraries. Install the required dependencies using pip:
   ```bash
   pip install -r requirements.txt
   ```
   Ensure that the `requirements.txt` file includes the following packages:
   - `numpy`
   - `matplotlib`

3. **Run the Application**:
   After installing the dependencies, you can run the main script to see the algorithm in action:
   ```bash
   python main.py
   ```

## Usage

Once the project is set up, you can run the algorithm and observe the packing process. The main components of the project include:

- **`main.py`**: The entry point of the application, containing the ACO algorithm and core logic.
- **`visualization.py`**: Handles the visualization of the packing process.
- **`constants.py`**: Contains configurable parameters for the algorithm, such as the number of rectangles, bin size, and number of iterations.

## Customization

The project is designed to be easily customizable. You can modify the following parameters in `constants.py`:

- **`NUM_RECTANGLES`**: The number of rectangles to generate and pack.
- **`MAX_RECT_WIDTH` and `MAX_RECT_HEIGHT`**: The maximum width and height for generated rectangles.
- **`BIN_WIDTH` and `BIN_HEIGHT`**: The dimensions of the bin/container.
- **`NUM_ITERATIONS`**: The number of iterations the ACO algorithm will run.

You can also adjust the visualization settings in `visualization.py`, such as the animation speed and the color of the rectangles.

## Visualization

The visualization is a key feature of this project, providing insight into how the ACO algorithm packs the rectangles. The application opens a window with two panes:

- **Left Pane**: Displays the "Packed Rectangles" bin, where the rectangles are packed in real-time as the algorithm progresses.
- **Right Pane**: Shows the "Remaining Rectangles" that have not yet been packed. Rectangles that have been packed will change color to indicate their status.
