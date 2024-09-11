import numpy as np
import random
import concurrent.futures
from constants import NUM_RECTANGLES, MAX_RECT_WIDTH, MAX_RECT_HEIGHT, BIN_WIDTH, BIN_HEIGHT, NUM_ITERATIONS
from visualization import run_animation

class Rectangle:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.x = 0  # x-coordinate of the bottom-left corner of the rectangle
        self.y = 0  # y-coordinate of the bottom-left corner of the rectangle
        self.rotated = False
    
    def rotate(self):
        self.width, self.height = self.height, self.width  
        self.rotated = not self.rotated 

# Generate random rectangles
rectangles = [Rectangle(random.randint(1, MAX_RECT_WIDTH), random.randint(1, MAX_RECT_HEIGHT)) for _ in range(NUM_RECTANGLES)]
bin_size = (BIN_WIDTH, BIN_HEIGHT)

# My heuristic prioritizes larger rectangles by squaring the total area - giving more weight to larger rectangles.
def calculate_heuristics(rectangles):
    return np.array([(rect.width * rect.height) **4 for rect in rectangles])

rectangles.sort(key=lambda r: r.width * r.height, reverse=True)

# Initialize pheromones and heuristics
pheromones = np.ones(len(rectangles))  # Initialize pheromones to 1 for each rectangle
heuristics = calculate_heuristics(rectangles)

def ant_colony_optimization(rectangles, bin_size, iterations=NUM_ITERATIONS):
    best_solution = None 
    best_fitness = float('inf')  # Best fitness value (lower is better)
    
    for iteration in range(iterations):
        print(f"\nIteration {iteration + 1}/{iterations}")
        ant_solutions = [] 

        # ThreadPoolExecutor to simulate multiple ants in parallel
        with concurrent.futures.ThreadPoolExecutor() as executor:
            futures = [executor.submit(simulate_ant, rectangles, bin_size) for _ in range(len(rectangles))]
            for future in concurrent.futures.as_completed(futures):
                packed_rects, unplaced_rects, fitness = future.result()
                ant_solutions.append((packed_rects, unplaced_rects, fitness))
                if fitness < best_fitness:
                    best_fitness = fitness
                    best_solution = packed_rects
                    print(f"New best solution found with fitness: {best_fitness}")
        
        # update pheromones based on the solutions found in this iteration
        update_pheromones(pheromones, ant_solutions)
    
    return best_solution

def simulate_ant(rectangles, bin_size):
    remaining_rects = rectangles.copy() 
    packed_rects = [] 
    
    while remaining_rects:
        # calculate probabilities for the remaining rectangles
        remaining_indices = [rectangles.index(r) for r in remaining_rects]
        remaining_pheromones = pheromones[remaining_indices]
        remaining_heuristics = heuristics[remaining_indices]
        
        # Increase the weight of larger rectangles
        probabilities = (remaining_pheromones ** 1) * (remaining_heuristics ** 2)
        probabilities = np.maximum(probabilities, 0) 

        if probabilities.sum() > 0:
            probabilities /= probabilities.sum()  #Normalize 
        else:
            probabilities = np.ones(len(probabilities)) / len(probabilities)  # Equal probabilities if all are zero
        
        rect_index = np.random.choice(len(remaining_rects), p=probabilities)  # Select rectangle
        selected_rect = remaining_rects.pop(rect_index)
        
        # Attempt to pack the selected rectangle
        x, y = find_position_for_rectangle(packed_rects, selected_rect, bin_size)
        
        if x is not None:
            selected_rect.x, selected_rect.y = x, y
            packed_rects.append(selected_rect)

    unplaced_rects = remaining_rects

    fitness = calculate_fitness(packed_rects, bin_size, unplaced_rects)  # Calculate fitness of the solution
    return packed_rects, unplaced_rects, fitness

def find_position_for_rectangle(packed_rects, rect, bin_size):
    for x in range(bin_size[0] - rect.width + 1):
        for y in range(bin_size[1] - rect.height + 1):
            if can_place(rect, x, y, packed_rects):
                return x, y
    
    # If not placeable, try rotating the rectangle
    rect.rotate() 
    for x in range(bin_size[0] - rect.width + 1):
        for y in range(bin_size[1] - rect.height + 1):
            if can_place(rect, x, y, packed_rects):
                return x, y
    
    rect.rotate()
    return None, None

def can_place(rect, x, y, packed_rects):
    for packed in packed_rects:
        #check if the current rectangle overlaps with any already packed rectangles
        if not (x + rect.width <= packed.x or
                x >= packed.x + packed.width or
                y + rect.height <= packed.y or
                y >= packed.y + packed.height):
            return False  
    return True  

def calculate_fitness(packed_rects, bin_size, unplaced_rects):
    total_area = sum([rect.width * rect.height for rect in packed_rects])
    unplaced_area = sum([rect.width * rect.height for rect in unplaced_rects])
    return (bin_size[0] * bin_size[1] - total_area) + unplaced_area

def update_pheromones(pheromones, solutions):
    decay = 0.8  # Decay factor for pheromones
    pheromones *= decay  # Apply decay to all pheromones
    
    for packed_rects, unplaced_rects, fitness in solutions:
        if fitness == 0:
            fitness = 1e-6  # small positive value to avoid division by zero
        
        for i in range(len(packed_rects)):
            pheromones[i] += 1 / fitness 

best_solution = ant_colony_optimization(rectangles, bin_size)
packed_rectangles = []
remaining_rectangles = rectangles.copy()

run_animation(rectangles, bin_size, packed_rectangles, remaining_rectangles, find_position_for_rectangle)

print("Best solution:", [(rect.x, rect.y, rect.width, rect.height) for rect in best_solution])
