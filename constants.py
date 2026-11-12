# Problem: random rectangles packed onto sheets (same setup as the original demo)
NUM_RECTANGLES = 65   # Number of rectangles to generate
MAX_RECT_WIDTH = 4    # Maximum width of any rectangle
MAX_RECT_HEIGHT = 4   # Maximum height of any rectangle
BIN_WIDTH = 21        # Sheet width
BIN_HEIGHT = 21       # Sheet height
KERF = 0              # Gap left between parts (saw blade width); same units as above
ALLOW_ROTATION = True # Parts may be turned 90 degrees

# Colony
NUM_ANTS = 20         # Layouts built per iteration
NUM_ITERATIONS = 80   # Iterations of the colony
ALPHA = 1.0           # Weight of pheromone (0 = no learning)
BETA = 2.0            # Weight of the heuristic (higher = greedier)
EVAPORATION = 0.1     # Share of pheromone lost each iteration
SEED = 7              # Random seed, for repeatable runs
